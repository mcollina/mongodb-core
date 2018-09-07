'use strict';

const crypto = require('crypto');
const Buffer = require('safe-buffer').Buffer;
const retrieveBSON = require('../connection/utils').retrieveBSON;
const MongoError = require('../error').MongoError;
const AuthProvider = require('./authProvider').AuthProvider;

const BSON = retrieveBSON();
const Binary = BSON.Binary;

let saslprep;

try {
  saslprep = require('saslprep');
} catch (e) {
  // don't do anything;
}

var parsePayload = function(payload) {
  var dict = {};
  var parts = payload.split(',');

  for (var i = 0; i < parts.length; i++) {
    var valueParts = parts[i].split('=');
    dict[valueParts[0]] = valueParts[1];
  }

  return dict;
};

var passwordDigest = function(username, password) {
  if (typeof username !== 'string') throw new MongoError('username must be a string');
  if (typeof password !== 'string') throw new MongoError('password must be a string');
  if (password.length === 0) throw new MongoError('password cannot be empty');
  // Use node md5 generator
  var md5 = crypto.createHash('md5');
  // Generate keys used for authentication
  md5.update(username + ':mongo:' + password, 'utf8');
  return md5.digest('hex');
};

// XOR two buffers
function xor(a, b) {
  if (!Buffer.isBuffer(a)) a = Buffer.from(a);
  if (!Buffer.isBuffer(b)) b = Buffer.from(b);
  const length = Math.max(a.length, b.length);
  const res = [];

  for (let i = 0; i < length; i += 1) {
    res.push(a[i] ^ b[i]);
  }

  return Buffer.from(res).toString('base64');
}

function H(method, text) {
  return crypto
    .createHash(method)
    .update(text)
    .digest();
}

function HMAC(method, key, text) {
  return crypto
    .createHmac(method, key)
    .update(text)
    .digest();
}

var _hiCache = {};
var _hiCacheCount = 0;
var _hiCachePurge = function() {
  _hiCache = {};
  _hiCacheCount = 0;
};

const hiLengthMap = {
  sha256: 32,
  sha1: 20
};

function HI(data, salt, iterations, cryptoMethod) {
  // omit the work if already generated
  const key = [data, salt.toString('base64'), iterations].join('_');
  if (_hiCache[key] !== undefined) {
    return _hiCache[key];
  }

  // generate the salt
  const saltedData = crypto.pbkdf2Sync(
    data,
    salt,
    iterations,
    hiLengthMap[cryptoMethod],
    cryptoMethod
  );

  // cache a copy to speed up the next lookup, but prevent unbounded cache growth
  if (_hiCacheCount >= 200) {
    _hiCachePurge();
  }

  _hiCache[key] = saltedData;
  _hiCacheCount += 1;
  return saltedData;
}

/**
 * Creates a new ScramSHA authentication mechanism
 * @class
 * @return {ScramSHA} A cursor instance
 */
class ScramSHA extends AuthProvider {
  constructor(bson, cryptoMethod) {
    super(bson);
    this.cryptoMethod = cryptoMethod || 'sha1';
  }

  static _getError(err, r) {
    if (err) {
      return err;
    }

    if (r.result['$err'] || r.result['errmsg']) {
      return r.result;
    }
  }

  _executeScram(server, connection, credentials, nonce, callback) {
    let username = credentials.username;
    const password = credentials.password;
    const db = credentials.source;

    const cryptoMethod = this.cryptoMethod;
    let mechanism = 'SCRAM-SHA-1';
    let processedPassword;

    if (cryptoMethod === 'sha256') {
      mechanism = 'SCRAM-SHA-256';

      const saslprepFn = (server.s && server.s.saslprep) || saslprep;

      processedPassword = saslprepFn ? saslprepFn(password) : password;
    } else {
      processedPassword = passwordDigest(username, password);
    }

    // Clean up the user
    username = username.replace('=', '=3D').replace(',', '=2C');

    // NOTE: This is done b/c Javascript uses UTF-16, but the server is hashing in UTF-8.
    // Since the username is not sasl-prep-d, we need to do this here.
    const firstBare = Buffer.concat([
      Buffer.from('n=', 'utf8'),
      Buffer.from(username, 'utf8'),
      Buffer.from(',r=', 'utf8'),
      Buffer.from(nonce, 'utf8')
    ]);

    // Build command structure
    const saslStartCmd = this._buildCommand(`${db}.$cmd`, {
      saslStart: 1,
      mechanism,
      payload: new Binary(Buffer.concat([Buffer.from('n,,', 'utf8'), firstBare])),
      autoAuthorize: 1
    });

    // Write the commmand on the connection
    server(connection, saslStartCmd, (err, r) => {
      // Do we have an error, handle it
      let tmpError = ScramSHA._getError(err, r);
      if (tmpError) {
        return callback(tmpError, null);
      }

      // Get the dictionary
      const dict = parsePayload(r.result.payload.value());

      // Unpack dictionary
      const iterations = parseInt(dict.i, 10);
      const salt = dict.s;
      const rnonce = dict.r;

      // Set up start of proof
      const withoutProof = `c=biws,r=${rnonce}`;
      const saltedPassword = HI(
        processedPassword,
        Buffer.from(salt, 'base64'),
        iterations,
        cryptoMethod
      );

      if (iterations && iterations < 4096) {
        const error = new MongoError(`Server returned an invalid iteration count ${iterations}`);
        return callback(error, false);
      }

      // Create the client key
      const clientKey = HMAC(cryptoMethod, saltedPassword, 'Client Key');

      // Create the stored key
      const storedKey = H(cryptoMethod, clientKey);

      // Create the authentication message
      const authMessage = [
        firstBare,
        r.result.payload.value().toString('base64'),
        withoutProof
      ].join(',');

      // Create client signature
      const clientSignature = HMAC(cryptoMethod, storedKey, authMessage);

      // Create client proof
      const clientProof = `p=${xor(clientKey, clientSignature)}`;

      // Create client final
      const clientFinal = [withoutProof, clientProof].join(',');

      // Create continue message
      const saslContinueCmd = this._buildCommand(`${db}.$cmd`, {
        saslContinue: 1,
        conversationId: r.result.conversationId,
        payload: new Binary(Buffer.from(clientFinal))
      });

      //
      // Execute sasl continue
      // Write the commmand on the connection
      server(connection, saslContinueCmd, (err, r) => {
        if (!r || r.result.done !== false) {
          return callback(err, r);
        }

        const retrySaslContinueCmd = this._buildCommand(`${db}.$cmd`, {
          saslContinue: 1,
          conversationId: r.result.conversationId,
          payload: Buffer.alloc(0)
        });

        // Write the commmand on the connection
        server(connection, retrySaslContinueCmd, callback);
      });
    });
  }

  _authenticateSingleConnection(server, connection, credentials, callback) {
    // Create a random nonce
    crypto.randomBytes(24, (err, buff) => {
      if (err) {
        return callback(err, null);
      }

      return this._executeScram(server, connection, credentials, buff.toString('base64'), callback);
    });
  }

  _auth(server, connections, credentials, callback) {
    this._checkSaslprep(server);
    super._auth(server, connections, credentials, callback);
  }

  _checkSaslprep(server) {
    const cryptoMethod = this.cryptoMethod;

    if (cryptoMethod === 'sha256') {
      let saslprepFn = (server.s && server.s.saslprep) || saslprep;

      if (!saslprepFn) {
        console.warn('Warning: no saslprep library specified. Passwords will not be sanitized');
      }
    }
  }
}

class ScramSHA1 extends ScramSHA {
  constructor(bson) {
    super(bson, 'sha1');
  }
}

class ScramSHA256 extends ScramSHA {
  constructor(bson) {
    super(bson, 'sha256');
  }
}

module.exports = { ScramSHA1, ScramSHA256 };
