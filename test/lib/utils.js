"use strict";

const {Cc, Ci, Cu, components} = require("chrome");
const {ActivityStreams} = require("addon/ActivityStreams");
const {stack: Cs} = components;

// If we didn't get passed a stack, maybe the error has one otherwise get it
// from our call context
function doThrow(error, stack = error.stack || Cs.caller) {
  let filename = "";
  if (stack instanceof Ci.nsIStackFrame) {
    filename = stack.filename;
  } else if (error.fileName) {
    filename = error.fileName;
  }

  throw (new Error(`Error at ${filename}`));
}

function doGetFile(path, allowNonexistent) {
  try {
    let lf = Cc["@mozilla.org/file/directory_service;1"]
      .getService(Ci.nsIProperties)
      .get("CurWorkD", Ci.nsILocalFile);

    let bits = path.split("/");
    for (let bit of bits.filter(bit => bit)) {
      if (bit !== "..") {
        lf.append(bit);
      } else {
        lf = lf.parent;
      }
    }

    if (!allowNonexistent && !lf.exists()) {
      // Not using do_throw(): caller will continue.
      let stack = Cs.caller;
      Cu.reportError(`[${stack.name} : ${stack.lineNumber}] ${lf.path} does not exist`);
    }

    return lf;
  }
  catch (ex) {
    doThrow(ex.toString(), Cs.caller);
  }

  return null;
}

function doDump(object, trailer) {
  dump(JSON.stringify(object, null, 1) + trailer); // eslint-disable-line no-undef
}

function getTestRecommendationProvider() {
  return {
    init() {},
    asyncSetRecommendedContent() {},
    setBlockedRecommendation() {},
    getRecommendation() {},
    uninit() {}
  };
}

function getTestSearchProvider() {
  return {
    init() {},
    uninit() {},
    on() {},
    off() {},
    get currentState() {
      return {
        engines: [],
        currentEngine: this.currentEngine
      };
    },
    get searchSuggestionUIStrings() {
      return {
        "searchHeader": "%S Search",
        "searchForSomethingWith": "Search for",
        "searchSettings": "Change Search Settings",
        "searchPlaceholder": "Search the Web"
      };
    },
    get currentEngine() {
      return {
        name: "",
        iconBuffer: []
      };
    },
    QueryInterface: {}
  };
}

function getTestActivityStream(options = {}) {
  const mockMetadataStore = {
    asyncConnect() {return Promise.resolve();},
    asyncReset() {return Promise.resolve();},
    asyncClose() {return Promise.resolve();},
    asyncInsert() {return Promise.resolve();},
    asyncGetMetadataByCacheKey() {return Promise.resolve([]);}
  };
  const mockShareProvider = {
    init() {},
    uninit() {}
  };
  if (!options.mockShareProvider) {
    options.shareProvider = mockShareProvider;
  }
  const mockPageScraper = {
    options: {framescriptPath: ""},
    init() {},
    uninit() {},
    _asyncParseAndSave() {}
  };

  options.pageScraper = mockPageScraper;
  options.searchProvider = getTestSearchProvider();
  options.recommendationProvider = getTestRecommendationProvider();
  let mockApp = new ActivityStreams(mockMetadataStore, options);
  return mockApp;
}

exports.doGetFile = doGetFile;
exports.doThrow = doThrow;
exports.doDump = doDump;
exports.getTestActivityStream = getTestActivityStream;
