const assert = require('assert');
const translate = require('./translate.js');
const requireFromString = require('require-from-string');
const https = require('https');
const MemoryStream = require('memorystream');

function setupMethods (soljson) {
  const copyString = function (str, ptr) {
    const length = soljson.lengthBytesUTF8(str);
    const buffer = soljson._malloc(length + 1);
    soljson.stringToUTF8(str, buffer, length + 1);
    soljson.setValue(ptr, buffer, '*');
  };

  const wrapCallback = function (callback) {
    assert(typeof callback === 'function', 'Invalid callback specified.');
    return function (path, contents, error) {
      const result = callback(soljson.Pointer_stringify(path));
      if (typeof result.contents === 'string') {
        copyString(result.contents, contents);
      }
      if (typeof result.error === 'string') {
        copyString(result.error, error);
      }
    };
  };

  // This calls compile() with args || cb
  const runWithReadCallback = function (readCallback, compile, args) {
    if (readCallback === undefined) {
      readCallback = function (path) {
        return {
          error: 'File import callback not supported'
        };
      };
    }

    // This is to support multiple versions of Emscripten.
    const addFunction = soljson.addFunction || soljson.Runtime.addFunction;
    const removeFunction = soljson.removeFunction || soljson.Runtime.removeFunction;

    const cb = addFunction(wrapCallback(readCallback));
    let output;
    try {
      args.push(cb);
      output = compile.apply(undefined, args);
    } catch (e) {
      removeFunction(cb);
      throw e;
    }
    removeFunction(cb);
    return output;
  };

  let compileJSON = null;
  if ('_compileJSON' in soljson) {
    compileJSON = soljson.cwrap('compileJSON', 'string', ['string', 'number']);
  }

  let compileJSONMulti = null;
  if ('_compileJSONMulti' in soljson) {
    compileJSONMulti = soljson.cwrap('compileJSONMulti', 'string', ['string', 'number']);
  }

  let compileJSONCallback = null;
  if ('_compileJSONCallback' in soljson) {
    const compileInternal = soljson.cwrap('compileJSONCallback', 'string', ['string', 'number', 'number']);
    compileJSONCallback = function (input, optimize, readCallback) {
      return runWithReadCallback(readCallback, compileInternal, [ input, optimize ]);
    };
  }

  let compileStandard = null;
  if ('_compileStandard' in soljson) {
    const compileStandardInternal = soljson.cwrap('compileStandard', 'string', ['string', 'number']);
    compileStandard = function (input, readCallback) {
      return runWithReadCallback(readCallback, compileStandardInternal, [ input ]);
    };
  }
  if ('_solidity_compile' in soljson) {
    const solidityCompile = soljson.cwrap('solidity_compile', 'string', ['string', 'number']);
    compileStandard = function (input, readCallback) {
      return runWithReadCallback(readCallback, solidityCompile, [ input ]);
    };
  }

  // Expects a Standard JSON I/O but supports old compilers
  const compileStandardWrapper = function (input, readCallback) {
    if (compileStandard !== null) {
      return compileStandard(input, readCallback);
    }

    function formatFatalError(message) {
      return JSON.stringify({
        errors: [
          {
            'type': 'SOLCError',
            'component': 'solcjs',
            'severity': 'error',
            'message': message,
            'formattedMessage': 'Error: ' + message
          }
        ]
      });
    }

    if (readCallback !== undefined && typeof readCallback !== 'function') {
      return formatFatalError('Invalid import callback supplied');
    }

    try {
      input = JSON.parse(input);
    } catch (e) {
      return formatFatalError('Invalid JSON supplied: ' + e.message);
    }

    if (input['language'] !== 'Solidity') {
      return formatFatalError('Only Solidity sources are supported');
    }

    // NOTE: this is deliberately `== null`
    if (input['sources'] == null || input['sources'].length === 0) {
      return formatFatalError('No input specified');
    }

    // Bail out early
    if ((input['sources'].length > 1) && (compileJSONMulti === null)) {
      return formatFatalError('Multiple sources provided, but compiler only supports single input');
    }

    function isOptimizerEnabled(input) {
      return input['settings'] && input['settings']['optimizer'] && input['settings']['optimizer']['enabled'];
    }

    function translateSources(input) {
      const sources = {};
      for (const source in input['sources']) {
        if (input['sources'][source]['content'] !== null) {
          sources[source] = input['sources'][source]['content'];
        } else {
          // force failure
          return null;
        }
      }
      return sources;
    }

    function librariesSupplied(input) {
      if (input['settings'] !== null) {
        return input['settings']['libraries'];
      }
    }

    function translateOutput(output) {
      try {
        output = JSON.parse(output);
      } catch (e) {
        return formatFatalError('Compiler returned invalid JSON: ' + e.message);
      }
      output = translate.translateJsonCompilerOutput(output);
      if (output == null) {
        return formatFatalError('Failed to process output');
      }
      return JSON.stringify(output);
    }

    const sources = translateSources(input);
    if (sources === null || Object.keys(sources).length === 0) {
      return formatFatalError('Failed to process sources');
    }

    // Try linking if libraries were supplied
    const libraries = librariesSupplied(input);

    // Try to wrap around old versions
    if (compileJSONCallback !== null) {
      return translateOutput(compileJSONCallback(JSON.stringify({'sources': sources}), isOptimizerEnabled(input), readCallback), libraries);
    }

    if (compileJSONMulti !== null) {
      return translateOutput(compileJSONMulti(JSON.stringify({'sources': sources}), isOptimizerEnabled(input)), libraries);
    }

    // Try our luck with an ancient compiler
    if (compileJSON !== null) {
      return translateOutput(compileJSON(sources[Object.keys(sources)[0]], isOptimizerEnabled(input)), libraries);
    }

    return formatFatalError('Compiler does not support any known interface.');
  };

  let version;
  if ('_solidity_version' in soljson) {
    version = soljson.cwrap('solidity_version', 'string', []);
  } else {
    version = soljson.cwrap('version', 'string', []);
  }

  const versionToSemver = function () {
    return translate.versionToSemver(version());
  };

  let license;
  if ('_solidity_license' in soljson) {
    license = soljson.cwrap('solidity_license', 'string', []);
  } else if ('_license' in soljson) {
    license = soljson.cwrap('license', 'string', []);
  } else {
    // pre 0.4.14
    license = function () {
      // return undefined
    };
  }

  return {
    version: version,
    semver: versionToSemver,
    license: license,
    lowlevel: {
      compileSingle: compileJSON,
      compileMulti: compileJSONMulti,
      compileCallback: compileJSONCallback,
      compileStandard: compileStandard
    },
    features: {
      legacySingleInput: compileJSON !== null,
      multipleInputs: compileJSONMulti !== null || compileStandard !== null,
      importCallback: compileJSONCallback !== null || compileStandard !== null,
      nativeStandardJSON: compileStandard !== null
    },
    compile: compileStandardWrapper,
    // Temporary wrappers to minimise breaking with other projects.
    // NOTE: to be removed in 0.5.2
    compileStandard: compileStandardWrapper,
    compileStandardWrapper: compileStandardWrapper,
    // Loads the compiler of the given version from the github repository
    // instead of from the local filesystem.
    loadRemoteVersion: function (versionString, cb) {
      const mem = new MemoryStream(null, {readable: false});
      const url = 'https://ethereum.github.io/solc-bin/bin/soljson-' + versionString + '.js';
      https.get(url, function (response) {
        if (response.statusCode !== 200) {
          cb(new Error('Error retrieving binary: ' + response.statusMessage));
        } else {
          response.pipe(mem);
          response.on('end', function () {
            cb(null, setupMethods(requireFromString(mem.toString(), 'soljson-' + versionString + '.js')));
          });
        }
      }).on('error', function (error) {
        cb(error);
      });
    },
    // Use this if you want to add wrapper functions around the pure module.
    setupMethods: setupMethods
  };
}

module.exports = setupMethods;
