/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

var TIMEOUT = 2000; // ms
const flag_TUP = 0x01;
const flag_AT = 0x40;

class ResultTracker {
  construct() {
    this.reset()
  }
  reset() {
    this.failCount = 0;
    this.todoCount = 0;
  }
  fail() {
    this.failCount += 1;
  }
  todo() {
    this.todoCount += 1;
  }
  get failures() {
    return this.failCount;
  }
  get todos() {
    return this.todoCount;
  }
  passed() {
    return this.failures == 0;
  }
  toString() {
    return "Failures: " + this.failures + " TODOs: " + this.todos;
  }
}

var gResults = new ResultTracker()

function append(id, text) {
  $("#"+id).text($("#"+id).text() + text);
}

function test(id, test, text) {
  if (!test) { gResults.fail(); }
  let message = (test)? "[PASS]" : "[FAIL]";
  message += " " + text + "\n";
  append(id, message);
  return test;
}

function testEqual(id, val1, val2, msg) {
  let result = (val1 == val2);
  let cmp = (result)? " == " : " != ";
  return test(id, result, msg + ": " + val1 + cmp + val2);
}

function resultColor(id) {
  if (gResults.failures == 0) {
    if (gResults.todos == 0) {
      $("#"+id).removeClass("failure"); $("#"+id).removeClass("todo"); $("#"+id).addClass("success");
    } else {
      $("#"+id).removeClass("failure"); $("#"+id).removeClass("success"); $("#"+id).addClass("todo");
    }
  } else {
    $("#"+id).removeClass("success"); $("#"+id).removeClass("todo"); $("#"+id).addClass("failure");
  }
}

function hexEncode(buf) {
  return Array.from(buf)
              .map(function(x){ return ("0"+x.toString(16)).substr(-2) })
              .join("");
}

function hexDecode(str) {
  return new Uint8Array(str.match(/../g).map(function(x){ return parseInt(x, 16) }));
}

function b64enc(buf) {
  return base64js.fromByteArray(buf)
                 .replace(/\+/g, "-")
                 .replace(/\//g, "_")
                 .replace(/=/g, "");
}

function string2buffer(str) {
  return (new Uint8Array(str.length)).map(function(x, i){ return str.charCodeAt(i) });
}

function buffer2string(buf) {
  let str = "";
  buf.map(function(x){ return str += String.fromCharCode(x) });
  return str;
}

function b64dec(str) {
  if (str.length % 4 == 1) {
    throw "Improper b64 string";
  }

  var b64 = str;
  while (b64.length % 4 != 0) {
    b64 += "=";
  }
  return new Uint8Array(base64js.toByteArray(b64));
}

function deriveAppAndChallengeParam(appId, clientData, attestation) {
  var appIdBuf = string2buffer(appId);
  return Promise.all([
    crypto.subtle.digest("SHA-256", appIdBuf),
    crypto.subtle.digest("SHA-256", clientData)
  ])
  .then(function(digests) {
    return {
      appParam: new Uint8Array(digests[0]),
      challengeParam: new Uint8Array(digests[1]),
      attestation: attestation
    };
  });
}

function assembleSignedData(appParam, flags, counter, challengeParam) {
  let signedData = new Uint8Array(32 + 1 + 4 + 32);
  appParam.map((x, i) => signedData[0 + i] = x);
  signedData[32] = flags;
  counter.map((x, i) => signedData[33 + i] = x);
  challengeParam.map((x, i) => signedData[37 + i] = x);
  return signedData;
}

function assembleRegistrationSignedData(appParam, challengeParam, keyHandle, pubKey) {
  let signedData = new Uint8Array(1 + 32 + 32 + keyHandle.length + 65);
  signedData[0] = 0x00;
  appParam.map((x, i) => signedData[1 + i] = x);
  challengeParam.map((x, i) => signedData[33 + i] = x);
  keyHandle.map((x, i) => signedData[65 + i] = x);
  pubKey.map((x, i) => signedData[65 + keyHandle.length + i] = x);
  return signedData;
}

function assemblePublicKeyBytesData(xCoord, yCoord) {
  // Produce an uncompressed EC key point. These start with 0x04, and then
  // two 32-byte numbers denoting X and Y.
  if (xCoord.length != 32 || yCoord.length != 32) {
    throw ("Coordinates must be 32 bytes long");
  }
  let keyBytes = new Uint8Array(65);
  keyBytes[0] = 0x04;
  xCoord.map((x, i) => keyBytes[1 + i] = x);
  yCoord.map((x, i) => keyBytes[33 + i] = x);
  return keyBytes;
}

var state = {
  // Raw messages
  createRequest: null,
  createResponse: null,
  // challengeBytes: null,
  // registeredKey: null,
  // signResponse: null,

  // Parsed values
  publicKey: null,
  keyHandle: null,
}

function webAuthnDecodeCBORAttestation(aCborAttBuf) {
  let attObj = CBOR.decode(aCborAttBuf);
  console.log(":: Attestation CBOR Object ::");
  if (!("authData" in attObj && "fmt" in attObj && "attStmt" in attObj)) {
    throw "Invalid CBOR Attestation Object";
  }
  if (!("sig" in attObj.attStmt && "x5c" in attObj.attStmt)) {
    throw "Invalid CBOR Attestation Statement";
  }

  return webAuthnDecodeAttestation(attObj.authData)
  .then(function (aAttestationObj) {
    aAttestationObj.attestationObject = attObj;
    return Promise.resolve(aAttestationObj);
  });
}

function webAuthnDecodeAttestation(aAuthData) {
  let rpIdHash = aAuthData.slice(0, 32);
  let flags = aAuthData.slice(32, 33);
  let counter = aAuthData.slice(33, 37);

  console.log(":: Attestation Object Data ::");
  console.log("RP ID Hash: " + hexEncode(rpIdHash));
  console.log("Counter: " + hexEncode(counter) + " Flags: " + flags);

  if ((flags & flag_AT) == 0x00) {
    // No Attestation Data, so we're done.
    return Promise.resolve({
      rpIdHash: rpIdHash,
      flags: flags,
      counter: counter,
    });
  }

  if (aAuthData.length < 38) {
    throw "Attestation Data flag was set, but not enough data passed in!";
  }

  let attData = {};
  attData.aaguid = aAuthData.slice(37, 53);
  attData.credIdLen = (aAuthData[53] << 8) + aAuthData[54];
  attData.credId = aAuthData.slice(55, 55 + attData.credIdLen);

  console.log(":: Attestation Data ::");
  console.log("AAGUID: " + hexEncode(attData.aaguid));

  cborPubKey = aAuthData.slice(55 + attData.credIdLen);
  var pubkeyObj = CBOR.decode(cborPubKey.buffer);
  if (!("alg" in pubkeyObj && "x" in pubkeyObj && "y" in pubkeyObj)) {
    throw "Invalid CBOR Public Key Object";
  }
  if (pubkeyObj.alg != "ES256") {
    throw "Unexpected public key algorithm";
  }

  let pubKeyBytes = assemblePublicKeyBytesData(pubkeyObj.x, pubkeyObj.y);
  console.log(":: CBOR Public Key Object Data ::");
  console.log("Algorithm: " + pubkeyObj.alg);
  console.log("X: " + pubkeyObj.x);
  console.log("Y: " + pubkeyObj.y);
  console.log("Uncompressed (hex): " + hexEncode(pubKeyBytes));

  return importPublicKey(pubKeyBytes)
  .then(function(aKeyHandle) {
    return Promise.resolve({
      rpIdHash: rpIdHash,
      flags: flags,
      counter: counter,
      attestationAuthData: attData,
      publicKeyBytes: pubKeyBytes,
      publicKeyHandle: aKeyHandle,
    });
  });
}

function importPublicKey(keyBytes) {
  if (keyBytes[0] != 0x04 || keyBytes.byteLength != 65) {
    throw "Bad public key octet string";
  }
  let jwk = {
    kty: "EC",
    crv: "P-256",
    x: b64enc(keyBytes.subarray(1,33)),
    y: b64enc(keyBytes.subarray(33))
  };
  return crypto.subtle.importKey("jwk", jwk, {name: "ECDSA", namedCurve: "P-256"}, true, ["verify"])
}

function verifySignature(key, data, derSig) {
  if (derSig.byteLength < 70) {
    console.log("bad sig: " + hexEncode(derSig))
    throw "Invalid signature length: " + derSig.byteLength;
  }

  // Poor man's ASN.1 decode
  // R and S are always 32 bytes.  If ether has a DER
  // length > 32, it's just zeros we can chop off.
  var lenR = derSig[3];
  var lenS = derSig[3 + lenR + 2];
  var padR = lenR - 32;
  var padS = lenS - 32;
  var sig = new Uint8Array(64);
  derSig.subarray(4+padR,4+lenR).map(function(x,i) { return sig[i] = x });
  derSig.subarray(4+lenR+2+padS,4+lenR+2+lenS).map(function(x,i) { return sig[32+i] = x });

  console.log("data: " + hexEncode(data));
  console.log("der:  " + hexEncode(derSig));
  console.log("raw:  " + hexEncode(sig));

  let asn1 = org.pkijs.fromBER(derSig);


  let alg = {name: "ECDSA", hash: "SHA-256"};
  return crypto.subtle.verify(alg, key, sig, data);
}

function asn1Okay(asn1) {
  if (asn1.result.error.length > 0) {
    console.log("Error: " + asn1.result.error);
    append("createOut", "Error: " + asn1.result.error + "\n");
    return false;
  }
  if (asn1.result.warnings.length > 0) {
    console.log("Warning: " + asn1.result.warnings.toString());
    append("createOut", "Warning: " + asn1.result.warnings.toString() + "\n");
    return false;
  }
  return true;
}

// OMG why are we encoding/decoding to get the right type?
// hexDecode(hexEncode(state.attestationCertDER)) === Uint8Array
// state.attestationCertDER === Uint8Array
// but unless we encode/decode, it's ~168 bytes after parsing, whereas it
// should be ~309 bytes.
function repairArray(a) {
  return hexDecode(hexEncode(a))
}

$(document).ready(function() {
  if (!PublicKeyCredential) {
    $("#error").text("Web Authentication API not found");
    $("button").addClass("inactive");
  }

  state.version = "U2F_V2";

  let success = true;

  $("#createButton").click(function() {
    $("#createOut").text("Contacting token... please perform your verification gesture (e.g., touch it, or plug it in)\n\n");
    gResults.reset();

    let challengeBytes = new Uint8Array(16);
    window.crypto.getRandomValues(challengeBytes);

    let createRequest = {
      challenge: challengeBytes,
      // Relying Party:
      rp: {
        name: "Acme"
      },

      // User:
      user: {
        id: "1098237235409872",
        name: "john.p.smith@example.com",
        displayName: "John P. Smith",
        icon: "https://pics.acme.com/00/p/aBjjjpqPb.png"
      },

      parameters: [
        {
          type: "public-key",
          algorithm: "ES256",
        }
      ],

      timeout: 60000,  // 1 minute
      excludeList: [] // No excludeList
    };
    if ($("#rpIdText").val()) {
      createRequest.rp.id = $("#rpIdText").val();
    }
    state.createRequest = createRequest;

    navigator.credentials.create({ publicKey: createRequest })
    .then(function (aNewCredentialInfo) {
      state.createResponse = aNewCredentialInfo
      append("createOut", "Note: Raw response in console.\n");
      console.log("Credentials.Create response: ", aNewCredentialInfo);

      return webAuthnDecodeCBORAttestation(aNewCredentialInfo.response.attestationObject.buffer);
    })
    .then(function (aAttestation) {
      testEqual("createOut", aAttestation.flags, (flag_TUP | flag_AT), "User presence and Attestation Object must both be set");
      testEqual("createOut", hexEncode(aAttestation.attestationAuthData.credId), hexEncode(state.createResponse.rawId), "Credential ID from CBOR and Raw ID match");
      state.keyHandle = state.createResponse.rawId;
      append("createOut", "Keypair Identifier: " + hexEncode(state.keyHandle) + "\n");
      append("createOut", "Public Key: " + hexEncode(aAttestation.publicKeyBytes) + "\n");

      state.publicKey = aAttestation.publicKeyHandle;

      append("createOut", "\n:: CBOR Attestation Object Data ::\n");
      append("createOut", "RP ID Hash: " + hexEncode(aAttestation.rpIdHash) + "\n");
      append("createOut", "Counter: " + hexEncode(aAttestation.counter) + " Flags: " + aAttestation.flags + "\n");
      append("createOut", "AAGUID: " + hexEncode(aAttestation.attestationAuthData.aaguid) + "\n");

      /* Decode U2F Attestation Certificates */
      append("createOut", "\n:: Attestation Certificate Information ::\n");
      if (aAttestation.attestationObject.attStmt.x5c.length != 1) {
        throw "Can't yet handle cert chains != 1 cert long";
      }

      state.attestationCertDER = aAttestation.attestationObject.attStmt.x5c[0];
      append("createOut", "DER-encoded Certificate: " + hexEncode(state.attestationCertDER) + "\n");

      let certAsn1 = org.pkijs.fromBER(repairArray(state.attestationCertDER).buffer);
      if (!test("createOut", asn1Okay(certAsn1), "Attestation Certificate parsed")) {
        throw "Attestation Certificate didn't parse correctly.";
      }

      state.attestationCert = new org.pkijs.simpl.CERT({ schema: certAsn1.result });
      append("createOut", "Attestation Cert\n");
      append("createOut", "Subject: " + state.attestationCert.subject.types_and_values[0].value.value_block.value + "\n");
      append("createOut", "Issuer: " + state.attestationCert.issuer.types_and_values[0].value.value_block.value + "\n");
      append("createOut", "Validity (in millis): " + (state.attestationCert.notAfter.value - state.attestationCert.notBefore.value + "\n"));

      state.attestationSig = aAttestation.attestationObject.attStmt.sig;
      let sigAsn1 = org.pkijs.fromBER(repairArray(state.attestationSig).buffer);
      if (!test("createOut", asn1Okay(certAsn1), "Attestation Signature parsed")) {
        throw "Attestation Signature failed to validate";
      }

      testEqual("createOut", sigAsn1.result.block_length, repairArray(state.attestationSig).buffer.byteLength, "Signature buffer has no unnecessary bytes.");

      append("createOut", "Attestation Signature (by the key in the cert, over the new credential):\n");
      let R = new Uint8Array(sigAsn1.result.value_block.value[0].value_block.value_hex);
      let S = new Uint8Array(sigAsn1.result.value_block.value[1].value_block.value_hex);
      append("createOut", "R-component: " + hexEncode(R) + "\n");
      append("createOut", "S-component: " + hexEncode(S) + "\n");

      /* Decode Client Data */
      append("createOut", "\n:: Client Data Information ::\n");
      let clientData = JSON.parse(buffer2string(state.createResponse.response.clientDataJSON));
      append("createOut", "Client Data object, in full:\n");
      append("createOut", JSON.stringify(clientData, null, 2) + "\n\n");

      testEqual("createOut", b64enc(challengeBytes), clientData.challenge, "Challenge matches");
      if(clientData.origin != window.location.origin) {
        // TODO: Remove this check - Spec changed
        append("createOut", "NOTE: Using WD-05 clientData.origin definition, not WD-06\n");
        let rpId = createRequest.rp.id || document.domain;
        testEqual("createOut", rpId, clientData.origin, "ClientData.origin matches the RP ID (WD-05)");
        gResults.todo();
      } else {
        testEqual("createOut", window.location.origin, clientData.origin, "ClientData.origin matches this origin (WD-06)");
      }
      if (clientData.hashAlg) {
        // TODO: Remove this check - Spec changed
        testEqual("createOut", "SHA-256", clientData.hashAlg, "Hash Algorithm is valid (WD-05)");
        append("createOut", "NOTE: Using WD-05 hashAlg name, not WD-06 hashAlgorithm\n");
        gResults.todo();
      } else if (clientData.hashAlgorithm) {
        testEqual("createOut", "SHA-256", clientData.hashAlgorithm, "Hash Algorithm is valid (WD-06)");
      } else {
        throw "Unknown spec version: Missing clientData.hashAlgorithm";
      }
    }).then(function (){
      append("createOut", "\n\nRaw request:\n");
      append("createOut", JSON.stringify(createRequest, null, 2) + "\n\n");
    }).catch(function (aErr) {
      gResults.fail();
      append("createOut", "Got error:\n");
      append("createOut", aErr.toString() + "\n\n");
    }).then(function (){
      resultColor("createOut");
      append("createOut", gResults.toString());
    });
  });

  $("#getButton").click(function() {
    $("#getOut").text("");
    gResults.reset();

    if (!state.createResponse) {
      gResults.fail();
      append("getOut", "Need to make a credential first:\n");
      return;
    }

    $("#getOut").text("Contacting token... please perform your verification gesture (e.g., touch it, or plug it in)\n\n");

    let newCredential = {
      type: "public-key",
      id: Uint8Array.from(state.createResponse.rawId),
      transports: ["usb", "nfc", "ble"],
    }

    let challengeBytes = new Uint8Array(16);
    window.crypto.getRandomValues(challengeBytes);

    let publicKeyCredentialRequestOptions = {
      challenge: challengeBytes,
      timeout: 60000,
      allowList: [newCredential]
    };

    if ($("#rpIdText").val()) {
      publicKeyCredentialRequestOptions.rpId = $("#rpIdText").val();
    }

    navigator.credentials.get({publicKey: publicKeyCredentialRequestOptions})
    .then(function(aAssertion) {
      console.log("Credentials.Get response: ", aAssertion);
      append("getOut", "Raw response in console.\n");

      let clientData = JSON.parse(buffer2string(aAssertion.response.clientDataJSON));
      testEqual("getOut", clientData.challenge, b64enc(challengeBytes), "Challenge is identical");
      if(clientData.origin != window.location.origin) {
        // TODO: Remove this check - Spec changed
        append("getOut", "NOTE: Using WD-05 clientData.origin definition, not WD-06\n");
        let rpId = publicKeyCredentialRequestOptions.rpId || document.domain;
        testEqual("getOut", rpId, clientData.origin, "ClientData.origin matches the RP ID (WD-05)");
        gResults.todo();
      } else {
        testEqual("getOut", window.location.origin, clientData.origin, "ClientData.origin matches this origin (WD-06)");
      }
      if (clientData.hashAlg) {
        // TODO: Remove this check - Spec changed
        testEqual("getOut", "SHA-256", clientData.hashAlg, "Hash Algorithm is valid (WD-05)");
        append("getOut", "NOTE: Using WD-05 hashAlg name, not WD-06 hashAlgorithm\n");
      } else if (clientData.hashAlgorithm) {
        testEqual("getOut", "SHA-256", clientData.hashAlgorithm, "Hash Algorithm is valid (WD-06)");
      } else {
        throw "Unknown spec version: Missing clientData.hashAlgorithm";
      }
        return webAuthnDecodeAttestation(aAssertion.response.authenticatorData)
      .then(function(decodedResult) {
        if (!testEqual("getOut", decodedResult.flags, flag_TUP, "User presence must be the only flag set")) {
          throw "Assertion's user presence byte not set correctly.";
        }

        testEqual("getOut", decodedResult.counter.length, 4, "Counter must be 4 bytes");

        // Assemble the signed data and verify the signature
        appId = document.domain
        if ($("#rpIdText").val()) {
          appId = $("#rpIdText").val();
        }

        return deriveAppAndChallengeParam(appId, aAssertion.response.clientDataJSON, decodedResult);
      })
      .then(function(aParams) {
        append("getOut", "ClientData buffer: " + hexEncode(aAssertion.response.clientDataJSON) + "\n\n");
        append("getOut", "ClientDataHash: " + hexEncode(aParams.challengeParam) + "\n\n");
        return assembleSignedData(aParams.appParam, aParams.attestation.flags,
                                  aParams.attestation.counter, aParams.challengeParam);
      })
      .then(function(aSignedData) {
        append("getOut", "Signed Data assembled: " + aSignedData + "\n");
        console.log(state.publicKey, aSignedData, aAssertion.response.signature);
        return verifySignature(state.publicKey, aSignedData, aAssertion.response.signature);
      })
      .then(function(aSignatureValid) {
        test("getOut", aSignatureValid, "The token signature must be valid.");
      });
    }).catch(function (aErr) {
      gResults.fail();
      append("getOut", "Got error:\n");
      append("getOut", aErr.toString() + "\n\n");
    }).then(function (){
      append("getOut", "\n\nRaw request:\n");
      append("getOut", JSON.stringify(publicKeyCredentialRequestOptions, null, 2) + "\n\n");
    }).then(function (){
      resultColor("getOut");
      append("getOut", gResults.toString());
    });

  });
});
