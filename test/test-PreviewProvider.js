/* globals require, exports, NetUtil */

"use strict";

const {before, after} = require("sdk/test/utils");
const simplePrefs = require("sdk/simple-prefs");
const self = require("sdk/self");
const {Loader} = require("sdk/test/loader");
const loader = Loader(module);
const httpd = loader.require("./lib/httpd");
const {Cu} = require("chrome");
const {PreviewProvider} = require("addon/PreviewProvider");
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const DISALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0"]);
const URL_FILTERS = [
  item => !!item.url,
  item => !!(new URL(item.url)),
  item => ALLOWED_PROTOCOLS.has(new URL(item.url).protocol),
  item => !DISALLOWED_HOSTS.has(new URL(item.url).hostname)
];

Cu.importGlobalProperties(["URL"]);
Cu.import("resource://gre/modules/NetUtil.jsm");

const gPort = 8089;
const gEndpointPrefix = `http://localhost:${gPort}`;
const gEmbedlyEndpoint = "/embedlyLinkData";
const gMetadataServiceEndpoint = "/metadataServiceLinkData";
const gMetadataServiceSource = "MetadataService";
const gEmbedlyServiceSource = "Embedly";
let gPreviewProvider;
let gMetadataStore = [];
let gMetdataSource = simplePrefs.prefs.metadataSource;
let gEmbedlyPref = simplePrefs.prefs["embedly.endpoint"];
let gMetadataPref = simplePrefs.prefs["metadata.endpoint"];
let gPrefEnabled = simplePrefs.prefs["previews.enabled"];

// mocks for metadataStore & tabTracker
const gMockMetadataStore = {
  asyncInsert(data) {
    gMetadataStore.push(data);
    return Promise.resolve();
  },
  asyncGetMetadataByCacheKey(cacheKeys) {
    let items = [];
    if (gMetadataStore[0]) {
      gMetadataStore[0].forEach(item => {
        if (cacheKeys.includes(item.cache_key)) {
          items.push(item);
        }
      });
    }
    return Promise.resolve(items);
  },
  asyncCacheKeyExists(key) {
    let exists = false;
    if (gMetadataStore[0]) {
      gMetadataStore[0].forEach(item => {
        if (key === item.cache_key) {
          exists = true;
        }
      });
    }
    return Promise.resolve(exists);
  }
};
const gMockTabTracker = {handlePerformanceEvent() {}, generateEvent() {}};

exports.test_only_request_links_once = function*(assert) {
  const msg1 = [{"url": "a.com", "sanitized_url": "a.com", "cache_key": "a.com"},
                {"url": "b.com", "sanitized_url": "b.com", "cache_key": "b.com"},
                {"url": "c.com", "sanitized_url": "c.com", "cache_key": "c.com"}];

  const msg2 = [{"url": "b.com", "sanitized_url": "b.com", "cache_key": "b.com"},
                {"url": "c.com", "sanitized_url": "c.com", "cache_key": "c.com"},
                {"url": "d.com", "sanitized_url": "d.com", "cache_key": "d.com"}];

  const endpoint = gPreviewProvider._getMetadataEndpoint();
  assert.ok(endpoint, "The embedly endpoint is set");
  let srv = httpd.startServerAsync(gPort);

  let urlsRequested = {};
  srv.registerPathHandler(gEmbedlyEndpoint, function handle(request, response) {
    let data = JSON.parse(
        NetUtil.readInputStreamToString(
          request.bodyInputStream,
          request.bodyInputStream.available()
        )
    );
    // count the times each url has been requested
    data.urls.forEach(url => (urlsRequested[url] = (urlsRequested[url] + 1) || 1));
    response.setHeader("Content-Type", "application/json", false);
    response.write(JSON.stringify({"urls": {urlsRequested}}));
  });

  // request 'b.com' and 'c.com' twice
  gPreviewProvider._asyncSaveLinks(msg1);
  yield gPreviewProvider._asyncSaveLinks(msg2);

  Object.keys(urlsRequested).forEach(url => {
    // each url should have a count of just one
    assert.equal(urlsRequested[url], 1, "URL was requested only once");
  });

  yield new Promise(resolve => {
    srv.stop(resolve);
  });
};

exports.test_filter_urls = function(assert) {
  const fakeData = {
    get validLinks() {
      return [
        {"url": "http://foo.com/", "title": "blah"},
        {"url": "https://www.foo.com/", "title": "blah"},
        {"url": "hTTp://fOo.com/", "title": "blah"},
        {"url": "http://localhost-foo.com", "title": "blah"}
      ];
    },
    get invalidLinks() {
      return [
        {"url": "", "title": "blah"},
        {"url": "ftp://foo.com/", "title": "blah"},
        {"url": "garbage://foo.com/", "title": "blah"},
        {"url": "HTTP://localhost:8080/", "title": "blah"},
        {"url": "http://127.0.0.1", "title": "blah"},
        {"url": "http://0.0.0.0", "title": "blah"},
        {"url": null, "title": "blah"}
      ];
    }
  };

  // all valid urls should be allowed through the filter and should be returned
  const goodUrls = fakeData.validLinks.filter(gPreviewProvider._URLFilter(URL_FILTERS));
  goodUrls.forEach((item, i) => assert.deepEqual(item, fakeData.validLinks[i], `${item} is a valid url`));

  // all invalid urls should be removed from the list of urls
  const badUrls = fakeData.invalidLinks.filter(gPreviewProvider._URLFilter(URL_FILTERS));
  assert.deepEqual(badUrls, [], "all bad links are removed");
};

exports.test_sanitize_urls = function(assert) {
  let sanitizedUrl = gPreviewProvider._sanitizeURL(null);
  assert.equal(sanitizedUrl, "", "if an empty url is passed, return the empty string");

  // the URL object throws if it is given a malformed url
  assert.throws(() => URL("foo.com"), "malformed URL");

  // remove any query parameter that is not in the whitelist
  let safeQuery = "http://www.foobar.com/?id=300&p=firefox&search=mozilla&q=query";
  sanitizedUrl = gPreviewProvider._sanitizeURL("http://www.foobar.com/?id=300&p=firefox&user=garbage&pass=trash&search=mozilla&foo=bar&q=query");
  assert.ok(safeQuery, sanitizedUrl, "removed any bad params and keep allowed params");

  // remove extra slashes and relative paths
  let removeSlashes = "http://www.foobar.com/foo/bar/foobar";
  sanitizedUrl = gPreviewProvider._sanitizeURL("http://www.foobar.com///foo////bar//foobar/");
  assert.equal(removeSlashes, sanitizedUrl, "removed extra slashes in pathname");
  let normalizePath = "http://www.foobar.com/foo/foobar/quuz.html";
  sanitizedUrl = gPreviewProvider._sanitizeURL("http://www.foobar.com/../foo/bar/../foobar/./quuz.html");
  assert.equal(normalizePath, sanitizedUrl, "normalized the pathname");

  // remove any sensitive information passed with basic auth
  let sensitiveUrl = "https://localhost.biz/";
  sanitizedUrl = gPreviewProvider._sanitizeURL("https://user:pass@localhost.biz/");
  assert.equal(sanitizedUrl.username, undefined, "removed username field");
  assert.equal(sanitizedUrl.password, undefined, "removed password field");
  assert.equal(sensitiveUrl, sanitizedUrl, "removed sensitive information from url");

  // remove the hash
  let removeHash = "http://www.foobar.com/";
  sanitizedUrl = gPreviewProvider._sanitizeURL("http://www.foobar.com/#id=20");
  assert.equal(removeHash, sanitizedUrl, "removed hash field");

  // Test with a %s in the query params
  let expectedUrl = "https://bugzilla.mozilla.org/buglist.cgi";
  sanitizedUrl = gPreviewProvider._sanitizeURL("https://bugzilla.mozilla.org/buglist.cgi?quicksearch=%s");
  assert.equal(expectedUrl, sanitizedUrl, "%s doesn't cause unhandled exception");
};

exports.test_process_links = function(assert) {
  const fakeData = [
    {"url": "http://foo.com/#foo", "title": "blah"},
    {"url": "http://foo.com/#bar", "title": "blah"},
    {"url": "http://www.foo.com/", "title": "blah"},
    {"url": "https://foo.com/", "title": "blah"}
  ];

  // process the links
  const processedLinks = gPreviewProvider._processLinks(fakeData);

  assert.equal(fakeData.length, processedLinks.length, "should not deduplicate or remove any links");

  // check that each link has added the correct fields
  processedLinks.forEach((link, i) => {
    assert.equal(link.url, fakeData[i].url, "each site has its original url");
    assert.ok(link.sanitized_url, "link has a sanitized url");
    assert.ok(link.cache_key, "link has a cache key");
    assert.ok(link.places_url, "link has a places url");
  });
};

exports.test_process_and_insert_links = function(assert) {
  const fakeData = {"url": "http://example.com/1", "title": "Title for example.com/1"};

  // process and insert the links
  gPreviewProvider.processAndInsertMetadata(fakeData, "metadata_source");
  assert.equal(gMetadataStore[0].length, 1, "saved one item");

  // check the first site inserted in the metadata DB
  assert.equal(gMetadataStore[0][0].url, fakeData.url, "site was saved as expected");
  assert.equal(gMetadataStore[0][0].cache_key, "example.com/1", "we added a cache_key for the site");
  assert.equal(gMetadataStore[0][0].metadata_source, "metadata_source", "we added a metadata_source for the site");
  assert.equal(gMetadataStore[0][0].title, fakeData.title, "we added the title from the metadata for the site");
};

exports.test_look_for_link_in_DB = function*(assert) {
  // the first time we check the link will not be in the DB
  const urlObject = {url: "https://www.dontexist.com", cache_key: "dontexist.com"};
  let doesLinkExist = yield gPreviewProvider.asyncLinkExist(urlObject.url);
  assert.equal(doesLinkExist, false, "link doesn't exist at first");

  // insert the link and check again, this time it will be in the DB
  gPreviewProvider.processAndInsertMetadata(urlObject);
  doesLinkExist = yield gPreviewProvider.asyncLinkExist(urlObject.url);
  assert.equal(doesLinkExist, true, "link does exist this time around");
};

exports.test_dedupe_urls = function(assert) {
  const fakeData = [
    {"url": "http://foo.com/", "title": "blah"},
    {"url": "http://www.foo.com/", "title": "blah"},
    {"url": "https://foo.com/", "title": "blah"},
    {"url": "http://foo.com/bar/foobar", "title": "blah"},
    {"url": "http://foo.com/bar////foobar", "title": "blah"},
    {"url": "https://www.foo.com/?q=param", "title": "blah"},
    {"url": "hTTp://fOo.com/", "title": "blah"},
    {"url": "http://localhost-foo.com", "title": "blah"}
  ];

  // dedupe a set of sanitized links while maintaining their original url
  let uniqueLinks = gPreviewProvider._uniqueLinks(fakeData);
  let expectedUrls = [
    {"url": "http://foo.com/", "title": "blah"},
    {"url": "http://foo.com/bar/foobar", "title": "blah"},
    {"url": "https://www.foo.com/?q=param", "title": "blah"},
    {"url": "http://localhost-foo.com", "title": "blah"}
  ];

  uniqueLinks.forEach((link, i) => {
    assert.ok(link.url, "each site has it's original url");
    assert.equal(link.url, expectedUrls[i].url, "links have been deduped");
  });
};

exports.test_throw_out_non_requested_responses = function*(assert) {
  const fakeSite1 = {"url": "http://example1.com/", "sanitized_url": "http://example1.com/", "cache_key": "example1.com/"};
  const fakeSite2 = {"url": "http://example2.com/", "sanitized_url": "http://example2.com/", "cache_key": "example2.com/"};
  const fakeSite3 = {"url": "http://example3.com/", "sanitized_url": "http://example3.com/", "cache_key": "example3.com/"};
  const fakeSite4 = {"url": "http://example4.com/", "sanitized_url": "http://example4.com/", "cache_key": "example4.com/"};
  // send site 1, 2, 4
  const fakeData = [fakeSite1, fakeSite2, fakeSite4];

  // receive site 1, 2, 3
  const fakeResponse = {
    "urls": {
      "http://example1.com/": {"embedlyMetaData": "some good embedly metadata for fake site 1"},
      "http://example2.com/": {"embedlyMetaData": "some good embedly metadata for fake site 2"},
      "http://example3.com/": {"embedlyMetaData": "oh no I didn't request this!"}
    }
  };

  const endpoint = gPreviewProvider._getMetadataEndpoint();
  assert.ok(endpoint, "The embedly endpoint is set");
  let srv = httpd.startServerAsync(gPort);

  srv.registerPathHandler(gEmbedlyEndpoint, function handle(request, response) {
    response.setHeader("Content-Type", "application/json", false);
    response.write(JSON.stringify(fakeResponse));
  });

  yield gPreviewProvider._asyncSaveLinks(fakeData);

  // database should contain example1.com and example2.com
  assert.equal(gMetadataStore[0].length, 2, "saved two items");
  assert.equal(gMetadataStore[0][0].url, fakeSite1.url, "first site was saved as expected");
  assert.equal(gMetadataStore[0][1].url, fakeSite2.url, "second site was saved as expected");

  // database should not contain example3.com and example4.com
  gMetadataStore[0].forEach(item => {
    assert.ok(item.url !== fakeSite3.url, "third site was not saved");
    assert.ok(item.url !== fakeSite4.url, "fourth site was not saved");
  });

  yield new Promise(resolve => {
    srv.stop(resolve);
  });
};

exports.test_mock_embedly_request = function*(assert) {
  const fakeSite = {
    "url": "http://example.com/",
    "title": null,
    "lastVisitDate": 1459537019061,
    "frecency": 2000,
    "favicon": null,
    "bookmarkDateCreated": 1459537019061,
    "type": "history",
    "sanitized_url": "http://example.com/",
    "cache_key": "example.com/"
  };
  const fakeRequest = [fakeSite];
  const fakeResponse = {"urls": {"http://example.com/": {"embedlyMetaData": "some embedly metadata"}}};

  const embedlyVersionQuery = "addon_version=";
  const endpoint = gPreviewProvider._getMetadataEndpoint();
  assert.ok(endpoint, "The embedly endpoint is set");

  let srv = httpd.startServerAsync(gPort);
  srv.registerPathHandler(gEmbedlyEndpoint, function handle(request, response) {
    // first, check that the version included in the query string
    assert.deepEqual(`${request.queryString}`, `${embedlyVersionQuery}${self.version}`, "we're hitting the correct endpoint");
    response.setHeader("Content-Type", "application/json", false);
    response.write(JSON.stringify(fakeResponse));
  });

  // make a request to embedly with 'fakeSite'
  yield gPreviewProvider._asyncSaveLinks(fakeRequest);

  // we should have saved the fake site into the database
  assert.deepEqual(gMetadataStore[0][0].embedlyMetaData, "some embedly metadata", "inserted and saved the embedly data");
  assert.ok(gMetadataStore[0][0].expired_at, "an expiry time was added");
  assert.equal(gMetadataStore[0][0].metadata_source, gEmbedlyServiceSource, "a metadata source was added from Embedly");

  // retrieve the contents of the database - don't go to embedly
  let cachedLinks = yield gPreviewProvider._asyncGetEnhancedLinks(fakeRequest);
  assert.equal(cachedLinks[0].lastVisitDate, fakeSite.lastVisitDate, "getEnhancedLinks should prioritize new data");
  assert.equal(cachedLinks[0].bookmarkDateCreated, fakeSite.bookmarkDateCreated, "getEnhancedLinks should prioritize new data");
  assert.deepEqual(gMetadataStore[0][0].cache_key, cachedLinks[0].cache_key, "the cached link is now retrieved next time");

  yield new Promise(resolve => {
    srv.stop(resolve);
  });
};

exports.test_no_metadata_source = function*(assert) {
  const fakeSite = {
    "url": "http://www.amazon.com/",
    "title": null,
    "sanitized_url": "http://www.amazon.com/",
    "cache_key": "amazon.com/"
  };
  const fakeResponse = {"urls": {"http://www.amazon.com/": {"embedlyMetaData": "some embedly metadata"}}};

  let cachedLink = yield gPreviewProvider._asyncGetEnhancedLinks([fakeSite]);
  assert.equal(cachedLink[0].metadata_source, "TippyTopProvider", "metadata came from TippyTopProvider");

  let srv = httpd.startServerAsync(gPort);
  srv.registerPathHandler(gEmbedlyEndpoint, function handle(request, response) {
    response.setHeader("Content-Type", "application/json", false);
    response.write(JSON.stringify(fakeResponse));
  });
  yield gPreviewProvider._asyncSaveLinks([fakeSite]);
  cachedLink = yield gPreviewProvider._asyncGetEnhancedLinks([fakeSite]);

  assert.equal(gMetadataStore[0][0].metadata_source, gEmbedlyServiceSource, "correct metadata_source in database");
  assert.equal(cachedLink[0].metadata_source, gEmbedlyServiceSource, "correct metadata_source returned for this link");

  yield new Promise(resolve => {
    srv.stop(resolve);
  });
};

exports.test_prefer_tippytop_favicons = function*(assert) {
  // we're using youtube here because it's known that the favicon that Embedly
  // returns is worse than the tippytop favicon - so we want to use the tippytop one
  const fakeSite = {
    "url": "http://www.youtube.com/",
    "title": null,
    "sanitized_url": "http://www.youtube.com/",
    "cache_key": "youtube.com/"
  };
  const fakeResponse = {
    "urls": {
      "http://www.youtube.com/": {
        "embedlyMetaData": "some embedly metadata",
        "favicon_url": "https://badicon.com",
        "background_color": "#BADCOLR"
      }
    }
  };

  // get the tippytop favicon_url and background_color and compare with
  // what we get from the cached link
  let tippyTopLink = gPreviewProvider._tippyTopProvider.processSite(fakeSite);
  let cachedLink = yield gPreviewProvider._asyncGetEnhancedLinks([fakeSite]);

  assert.equal(tippyTopLink.favicon_url, cachedLink[0].favicon_url, "TippyTopProvider added a favicon_url");
  assert.equal(tippyTopLink.background_color, cachedLink[0].background_color, "TippyTopProvider added a background_color");

  let srv = httpd.startServerAsync(gPort);
  srv.registerPathHandler(gEmbedlyEndpoint, function handle(request, response) {
    response.setHeader("Content-Type", "application/json", false);
    response.write(JSON.stringify(fakeResponse));
  });
  // insert a link with some less nice icons in it and get them back
  yield gPreviewProvider._asyncSaveLinks([fakeSite]);
  cachedLink = yield gPreviewProvider._asyncGetEnhancedLinks([fakeSite]);

  assert.equal(tippyTopLink.favicon_url, cachedLink[0].favicon_url, "we still took the better tippyTop favicon_url");
  assert.equal(tippyTopLink.background_color, cachedLink[0].background_color, "we still took the better tippyTop background_color");
  assert.equal(fakeResponse.urls["http://www.youtube.com/"].embedlyMetaData, cachedLink[0].embedlyMetaData, "but we still have other metadata");

  yield new Promise(resolve => {
    srv.stop(resolve);
  });
};

exports.test_get_enhanced_disabled = function*(assert) {
  const fakeData = [
    {url: "http://foo.com/", lastVisitDate: 1459537019061}
  ];
  simplePrefs.prefs["previews.enabled"] = false;
  let cachedLinks = yield gPreviewProvider._asyncGetEnhancedLinks(fakeData);
  assert.deepEqual(cachedLinks, fakeData, "if disabled, should return links as is");
};

exports.test_change_metadata_endpoint = function*(assert) {
  const fakeSite = {
    "url": "http://foo.com/",
    "title": null,
    "lastVisitDate": 1459537019061,
    "frecency": 2000,
    "favicon": null,
    "bookmarkDateCreated": 1459537019061,
    "type": "history",
    "sanitized_url": "http://foo.com/",
    "cache_key": "foo.com/"
  };
  const fakeRequest = [fakeSite];
  const fakeResponse = {"urls": {"http://foo.com/": {"metaData": "some metadata found by MetadataService"}}};
  const metadataVersionQuery = `?addon_version=${self.version}`;

  // change the endpoint to point to metadata service
  simplePrefs.prefs.metadataSource = gMetadataServiceSource;
  const endpoint = gPreviewProvider._getMetadataEndpoint();
  assert.equal(endpoint, `${gEndpointPrefix}${gMetadataServiceEndpoint}${metadataVersionQuery}`, "The new endpoint is set");
  assert.equal(gPreviewProvider._getMetadataSourceName(), gMetadataServiceSource, "We updated the source name");

  let srv = httpd.startServerAsync(gPort);
  srv.registerPathHandler(gMetadataServiceEndpoint, function handle(request, response) {
    assert.deepEqual(`${request._path}`, gMetadataServiceEndpoint, "we're hitting the correct endpoint");
    response.setHeader("Content-Type", "application/json", false);
    response.write(JSON.stringify(fakeResponse));
  });

  // make a request to MetadataService with 'fakeSite'
  yield gPreviewProvider._asyncSaveLinks(fakeRequest);

  // we should have saved the fake site into the database with MetadataService data
  assert.deepEqual(gMetadataStore[0][0].metaData, "some metadata found by MetadataService", "inserted and saved the metadata");
  assert.equal(gMetadataStore[0][0].metadata_source, gMetadataServiceSource, "the metadata source came from our service");

  yield new Promise(resolve => {
    srv.stop(resolve);
  });
};

exports.test_faulty_metadata_endpoint = function(assert) {
  // change the endpoint to some garbage
  simplePrefs.prefs.metadataSource = "garbagePref";
  let endpoint = gPreviewProvider._getMetadataEndpoint();
  const metadataVersionQuery = `?addon_version=${self.version}`;
  assert.equal(endpoint, `${gEndpointPrefix}${gEmbedlyEndpoint}${metadataVersionQuery}`, "fallback to Embedly if the metadataSource is invalid");
  assert.equal(gPreviewProvider._getMetadataSourceName(), gEmbedlyServiceSource, "fallback to Embedly as source");

  // change it back to make sure it overrides
  simplePrefs.prefs.metadataSource = gMetadataServiceSource;
  endpoint = gPreviewProvider._getMetadataEndpoint();
  assert.equal(endpoint, `${gEndpointPrefix}${gMetadataServiceEndpoint}${metadataVersionQuery}`, "properly set the endpoint");
  assert.equal(gPreviewProvider._getMetadataSourceName(), gMetadataServiceSource, "properly set the source");
};

exports.test_metadata_service_experiment = function(assert) {
  // before we decide if we are in the experiment we always have a default of Embedly
  const oldPrefValue = simplePrefs.prefs.metadataSource;
  assert.equal(oldPrefValue, gEmbedlyServiceSource, "sanity check that our default is Embedly");

  // force us into the metadataService experiment
  let mockExperimentProvider = {data: {metadataService: true}};
  gPreviewProvider = new PreviewProvider(gMockTabTracker, gMockMetadataStore, mockExperimentProvider, {initFresh: true});

  // should update the pref and the source
  const newPrefValue = simplePrefs.prefs.metadataSource;
  assert.equal(gPreviewProvider._getMetadataSourceName(), gMetadataServiceSource, "properly set the source if we are in the experiment");
  assert.equal(newPrefValue, gMetadataServiceSource, "properly set the actual pref itself");
};

before(exports, () => {
  simplePrefs.prefs.metadataSource = gEmbedlyServiceSource;
  simplePrefs.prefs["embedly.endpoint"] = `${gEndpointPrefix}${gEmbedlyEndpoint}`;
  simplePrefs.prefs["metadata.endpoint"] = `${gEndpointPrefix}${gMetadataServiceEndpoint}`;
  simplePrefs.prefs["previews.enabled"] = true;
  let mockExperimentProvider = {data: {metadataService: false}};
  gPreviewProvider = new PreviewProvider(gMockTabTracker, gMockMetadataStore, mockExperimentProvider, {initFresh: true});
});

after(exports, () => {
  simplePrefs.prefs.metadataSource = gMetdataSource;
  simplePrefs.prefs["embedly.endpoint"] = gEmbedlyPref;
  simplePrefs.prefs["metadata.endpoint"] = gMetadataPref;
  simplePrefs.prefs["previews.enabled"] = gPrefEnabled;
  gMetadataStore = [];
  gPreviewProvider.uninit();
});

require("sdk/test").run(exports);
