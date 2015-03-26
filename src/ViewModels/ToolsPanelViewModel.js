'use strict';

/*global require,L,URI*/
var CatalogGroup = require('../Models/CatalogGroup');
var corsProxy = require('../Core/corsProxy');
var loadView = require('../Core/loadView');
var pollToPromise = require('../Core/pollToPromise');
var PopupMessageViewModel = require('./PopupMessageViewModel');

var CesiumMath = require('../../third_party/cesium/Source/Core/Math');
var defined = require('../../third_party/cesium/Source/Core/defined');
var DeveloperError = require('../../third_party/cesium/Source/Core/DeveloperError');
var getTimestamp = require('../../third_party/cesium/Source/Core/getTimestamp');
var knockout = require('../../third_party/cesium/Source/ThirdParty/knockout');
var loadImage = require('../../third_party/cesium/Source/Core/loadImage');
var loadWithXhr = require('../../third_party/cesium/Source/Core/loadWithXhr');
var Rectangle = require('../../third_party/cesium/Source/Core/Rectangle');
var throttleRequestByServer = require('../../third_party/cesium/Source/Core/throttleRequestByServer');
var WebMercatorTilingScheme = require('../../third_party/cesium/Source/Core/WebMercatorTilingScheme');
var when = require('../../third_party/cesium/Source/ThirdParty/when');

var ToolsPanelViewModel = function(options) {
    if (!defined(options) || !defined(options.application)) {
        throw new DeveloperError('options.application is required.');
    }

    this.application = options.application;

    this._domNodes = undefined;

    this.cacheFilter = 'opened';
    this.cacheLevels = 3;
    this.useCache = false;
    this.ckanFilter = 'opened';
    this.ckanUrl = 'http://localhost';
    this.ckanApiKey = 'xxxxxxxxxxxxxxx';

    knockout.track(this, ['cacheFilter', 'cacheLevels', 'useCache', 'ckanFilter', 'ckanUrl', 'ckanApiKey']);
};

ToolsPanelViewModel.prototype.show = function(container) {
    this._domNodes = loadView(require('fs').readFileSync(__dirname + '/../Views/ToolsPanel.html', 'utf8'), container, this);
};

ToolsPanelViewModel.prototype.close = function() {
    for (var i = 0; i < this._domNodes.length; ++i) {
        var node = this._domNodes[i];
        if (defined(node.parentElement)) {
            node.parentElement.removeChild(node);
        }
    }
};

ToolsPanelViewModel.prototype.closeIfClickOnBackground = function(viewModel, e) {
    if (e.target.className === 'modal-background') {
        this.close();
    }
    return true;
};

ToolsPanelViewModel.prototype.cacheTiles = function() {
    var requests = [];
    var promises = [];
    getAllRequests(['wms', 'esri-mapServer'], this.cacheFilter, requests, this.application.catalog.group, promises);

    var that = this;
    when.all(promises, function() {
        console.log('Requesting tiles from ' + requests.length + ' data sources.');
        requestTiles(that, requests, that.cacheLevels);
    });
};

ToolsPanelViewModel.prototype.exportFile = function() {
    //Create the initialization file text
    var catalog = this.application.catalog.serializeToJson({serializeForSharing:false});
    var camera = getDegreesRect(this.application.homeView.rectangle);
    var initJsonObject = { corsDomains: corsProxy.corsDomains, camera: camera, services: [], catalog: catalog};
    var initFile = JSON.stringify(initJsonObject, null, 4);

    //Download it to the browser
    var pom = document.createElement('a');
    pom.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(initFile));
    pom.setAttribute('download', 'data_menu.json');
    pom.click();
};

ToolsPanelViewModel.prototype.exportCkan = function() {
    var requests = [];
    var promises = [];
    getAllRequests(['wms', 'esri-mapServer'], this.ckanFilter, requests, this.application.catalog.group, promises);

    var that = this;
    when.all(promises, function() {
        console.log('Exporting metadata from ' + requests.length + ' data sources.');
        populateCkan(requests, that.ckanUrl, that.ckanApiKey);
    });
};


ToolsPanelViewModel.open = function(container, options) {
    var viewModel = new ToolsPanelViewModel(options);
    viewModel.show(container);
    return viewModel;
};


function getAllRequests(types, mode, requests, group, promises) {
    for (var i = 0; i < group.items.length; ++i) {
        var item = group.items[i];
        if (item instanceof CatalogGroup) {
            if (item.isOpen || mode === 'all' || mode === 'enabled') {
                getAllRequests(types, mode, requests, item, promises);
            }
        } else if ((types.indexOf(item.type) !== -1) && (mode !== 'enabled' || item.isEnabled)) {
            var enabledHere = !item.isEnabled;
            if (enabledHere) {
                item._enable();
            }

            var imageryProvider = item._imageryLayer.imageryProvider;

            requests.push({
                item : item,
                group : group.name,
                enabledHere : enabledHere,
                provider : imageryProvider
            });

            promises.push(whenImageryProviderIsReady(imageryProvider));
        }
    }
}

function whenImageryProviderIsReady(imageryProvider) {
    return pollToPromise(function() {
        return imageryProvider.ready;
    }, { timeout: 60000, pollInterval: 100 });
}

function requestTiles(toolsPanel, requests, maxLevel) {
    var app = toolsPanel.application;

    var urls = [];
    var names = [];
    var stats = [];
    var uniqueStats = [];
    var name;
    var stat;

    loadImage.createImage = function(url, crossOrigin, deferred) {
        urls.push(url);
        names.push(name);
        stats.push(stat);
        if (defined(deferred)) {
            deferred.resolve();
        }
    };

    var oldMax = throttleRequestByServer.maximumRequestsPerServer;
    throttleRequestByServer.maximumRequestsPerServer = Number.MAX_VALUE;

    var i;
    for (i = 0; i < requests.length; ++i) {
        var request = requests[i];

        var extent;
        if (request.provider.rectangle && request.item.rectangle) {
            extent = Rectangle.intersection(request.provider.rectangle, request.item.rectangle);
        } else if (request.provider.rectangle) {
            extent = request.provider.rectangle;
        } else if (request.item.rectangle) {
            extent = request.item.rectangle;
        }

        if (!defined(extent)) {
            extent = app.homeView.rectangle;
        }

        name = request.item.name;

        var tilingScheme;
        var leaflet = app.leaflet;
        if (defined(leaflet)) {
            request.provider = request.item._imageryLayer;
            tilingScheme = new WebMercatorTilingScheme();
            leaflet.map.addLayer(request.provider);
        } else {
            tilingScheme = request.provider.tilingScheme;
        }

        stat = {
            name: name,
            success: {
                min: 999999,
                max: 0,
                sum: 0,
                number: 0,
                slow: 0
            },
            error: {
                min: 999999,
                max: 0,
                sum: 0,
                number: 0
            }
        };
        uniqueStats.push(stat);

        for (var level = 0; level <= maxLevel; ++level) {
            var nw = tilingScheme.positionToTileXY(Rectangle.northwest(extent), level);
            var se = tilingScheme.positionToTileXY(Rectangle.southeast(extent), level);
            if (!defined(nw) || !defined(se)) {
                // Extent is probably junk.
                continue;
            }

            for (var y = nw.y; y <= se.y; ++y) {
                for (var x = nw.x; x <= se.x; ++x) {
                    if (defined(leaflet)) {
                        var coords = new L.Point(x, y);
                        coords.z = level;
                        var url = request.provider.getTileUrl(coords);
                        loadImage.createImage(url);
                    }
                    else {
                        if (!defined(request.provider.requestImage(x, y, level))) {
                            console.log('too many requests in flight');
                        }
                    }
                }
            }
        }
        if (request.enabledHere) {
            if (defined(leaflet)) {
               leaflet.map.removeLayer(request.provider);
            }
            request.item._disable();
        }
    }

    loadImage.createImage = loadImage.defaultCreateImage;
    throttleRequestByServer.maximumRequestsPerServer = oldMax;

    var popup = PopupMessageViewModel.open('ui', {
        title: 'Dataset Testing',
        message: '<div>Requesting ' + urls.length + ' URLs</div>'
    });

    var maxRequests = 1;
    var nextRequestIndex = 0;
    var inFlight = 0;
    var urlsRequested = 0;

    function doneUrl(stat, startTime, error) {
        var ellapsed = getTimestamp() - startTime;

        var resultStat;
        if (error) {
            resultStat = stat.error;
        } else {
            resultStat = stat.success;
            if (ellapsed > maxAverage) {
                resultStat.slow ++;
            }
        }

        ++resultStat.number;
        resultStat.sum += ellapsed;

        if (ellapsed > resultStat.max) {
            resultStat.max = ellapsed;
        }
        if (ellapsed < resultStat.min) {
            resultStat.min = ellapsed;
        }

        --inFlight;
        doNext();
    }

    function getNextUrl() {
        var url;
        var stat;

        if (nextRequestIndex >= urls.length) {
            return undefined;
        }

        if ((nextRequestIndex % 10) === 0) {
            //popup.message += '<div>Finished ' + nextRequestIndex + ' URLs.</div>';
        }

        url = urls[nextRequestIndex];
        name = names[nextRequestIndex]; //track for error reporting
        stat = stats[nextRequestIndex];
        ++nextRequestIndex;

        return {
            url: url,
            name: name,
            stat: stat
        };
    }

    var last;
    var failedRequests = 0;
    var slowDatasets = 0;

    var maxAverage = 400;
    var maxMaximum = 800;

    function doNext() {
        var next = getNextUrl();
        if (!defined(last) && defined(next)) {
            popup.message += '<h1>' + next.name + '</h1>';
        }
        if (defined(last) && (!defined(next) || next.name !== last.name)) {
            popup.message += '<div>';
            if (last.stat.error.number === 0) {
                popup.message += last.stat.success.number + ' tiles <span style="color:green">✓</span>';
            } else {
                popup.message += last.stat.success.number + last.stat.error.number + ' tiles (<span style="color:red">' + last.stat.error.number + ' failed</span>)';
            }
            if (last.stat.success.slow > 0) {
                popup.message += ' (' + last.stat.success.slow + ' slow) ';
            }
            var average = Math.round(last.stat.success.sum / last.stat.success.number);
            popup.message += ' <span ' + (average > maxAverage ? 'style="colour: red"' : '') + '>' + 
              'Average: ' + average + 'ms</span>&nbsp;';
            popup.message += '(<span ' + (last.stat.success.max > maxMaximum ? 'style="color: red"' : '') + '>' + 
              'Max: ' + Math.round(last.stat.success.max) + 'ms</span>)';
            popup.message += '</div>';

            failedRequests += last.stat.error.number;

            if (average > maxAverage || last.stat.success.max > maxMaximum) {
                ++slowDatasets;
            }

            if (next) {
                popup.message += '<h1>' + next.name + '</h1>';
            }
        }

        last = next;

        if (!defined(next)) {
            if (inFlight === 0) {
                popup.message += '<h1>Summary</h1>';
                popup.message += '<div>Finished ' + nextRequestIndex + ' URLs.  DONE!</div>';
                popup.message += '<div>Actual number of URLs requested: ' + urlsRequested + '</div>';
                popup.message += '<div style="' + (failedRequests > 0 ? 'color:red' : '') + '">Failed tile requests: ' + failedRequests + '</div>';
                popup.message += '<div style="' + (slowDatasets > 0 ? 'color:red' : '') + '">Slow datasets: ' + slowDatasets + 
                ' <i>(>' + maxAverage + 'ms average, or >' + maxMaximum + 'ms maximum)</i></div>';
                
            }
            return;
        }

        ++urlsRequested;
        ++inFlight;

        ++next.stat.number;

        var url = next.url;

        if (!toolsPanel.useCache) {
            url = url.replace('/proxy/h', '/proxy/_0d/h');
        }

        var start = getTimestamp();
        loadWithXhr({
            url : url
        }).then(function() {
            doneUrl(next.stat, start, false);
        }).otherwise(function(e) {
            popup.message += '<div>Tile request resulted in an error' + (e.statusCode ? (' (code ' + e.statusCode + '):') : ':') + '</div>';
            popup.message += '<div>' + next.url + '</div>';
            doneUrl(next.stat, start, true);
        });
    }

    for (i = 0; i < maxRequests; ++i) {
        doNext();
    }
}


function postToCkan(url, dataObj, func, apiKey) {
    return loadWithXhr({
        url : url,
        method : "POST",
        data : JSON.stringify(dataObj),
        headers : {'Authorization' : apiKey},
        responseType : 'json'
    }).then(function(result) {
        func(result);
    }).otherwise(function() {
        console.log('Returned an error while working on url', url);
    });
}

function getCkanName(name) {
    var ckanName = name.toLowerCase().replace(/\W/g,'-');
    return ckanName;
}

function getCkanRect(rect) {
    return CesiumMath.toDegrees(rect.west).toFixed(4) + ',' +
        CesiumMath.toDegrees(rect.south).toFixed(4) + ',' +
        CesiumMath.toDegrees(rect.east).toFixed(4) + ',' +
        CesiumMath.toDegrees(rect.north).toFixed(4);
}

function getDegreesRect(rect) {
    return { west: CesiumMath.toDegrees(rect.west), 
        south: CesiumMath.toDegrees(rect.south), 
        east: CesiumMath.toDegrees(rect.east), 
        north: CesiumMath.toDegrees(rect.north)};
}

function cleanUrl(url) {
    var uri = new URI(url);
    uri.search('');
    return uri.toString();
}

function populateCkan(requests, server, apiKey) {

    var groups = [];
    var orgs = [];
    var orgsCkan = [];
    var groupsCkan = [];
    var packagesCkan = [];

    var ckanServer = server; //get from entry field in ui (maxLevels)
    var ckanApiKey = apiKey; //get from url - #populate-cache=xxxxxxxxx

    for (var i = 0; i < requests.length; ++i) {
        var gname = getCkanName(requests[i].group);
        if (groups[gname] === undefined) {
            groups[gname] = { title: requests[i].group };
        }
        var orgTitle = requests[i].item.dataCustodian;
        var links = orgTitle.match(/[^[\]]+(?=])/g);
        if (links.length > 0) {
            orgTitle = links[0];  //use first link text as title
        }
        requests[i].owner_org = orgTitle;
        var oname = getCkanName(orgTitle);
        if (orgs[oname] === undefined) {
            orgs[oname] = { title: orgTitle, description: requests[i].item.dataCustodian };
        }
    }

    var promises = [];
    promises[0] = postToCkan(
        ckanServer + '/api/3/action/organization_list', 
        {}, 
        function(results) { orgsCkan = results.result; },
        ckanApiKey
    );
    promises[1] = postToCkan(
        ckanServer + '/api/3/action/group_list', 
        {}, 
        function(results) { groupsCkan = results.result; },
        ckanApiKey
    );
    promises[2] = postToCkan(
        ckanServer + '/api/3/action/package_list', 
        {}, 
        function(results) { packagesCkan = results.result; },
        ckanApiKey
    );

    when.all(promises).then(function() {
        var ckanRequests = [], ckanName, i, j, found;
        for (ckanName in groups) {
            if (groups.hasOwnProperty(ckanName)) {
                found = false;
                for (j = 0; j < groupsCkan.length; j++) {
                    if (ckanName === groupsCkan[j]) {
                        found = true;
                        break;
                    }
                }
                ckanRequests.push( {
                    "url": ckanServer + '/api/3/action/group_' + (found ? 'update' : 'create'),
                    "data" : {"name": ckanName, "title": groups[ckanName].title, "id": (found ? ckanName : '')}
                });
            }
        }
        for (ckanName in orgs) {
            if (orgs.hasOwnProperty(ckanName)) {
                found = false;
                for (j = 0; j < orgsCkan.length; j++) {
                    if (ckanName === orgsCkan[j]) {
                        found = true;
                        break;
                    }
                }
                ckanRequests.push({
                    "url": ckanServer + '/api/3/action/organization_' + (found ? 'update' : 'create'),
                    "data" : {"name": ckanName, "title": orgs[ckanName].title, 
                            "description": orgs[ckanName].description, "id": (found ? ckanName : '')}
                });
            }
        }
        for (i = 0; i < requests.length; i++) {
            found = false;
            for (j = 0; j < packagesCkan.length; j++) {
                if (getCkanName(requests[i].item.name) === packagesCkan[j]) {
                    found = true;
                    break;
                }
            }
            var bboxString = getCkanRect(requests[i].item.rectangle);
            var extrasList = [ { "key": "geo_coverage", "value":  bboxString} ];
            if (defined(requests[i].item.dataUrlType) && requests[i].item.dataUrlType !== 'wfs') {
                extrasList.push({ "key": "data_url_type", "value":  requests[i].item.dataUrlType});
            }
            if (defined(requests[i].item.dataUrl)) {
                var dataUrl = "";
                if (requests[i].item.dataUrlType === 'wfs') {
                    var baseUrl = cleanUrl(requests[i].item.dataUrl);
                    if ((baseUrl !== requests[i].item.url)) {
                        dataUrl = baseUrl;
                    }
                } else if (requests[i].item.dataUrlType !== 'none') {
                    dataUrl = requests[i].item.dataUrl;
                }
                if (dataUrl !== "") {
                    extrasList.push({ "key": "data_url", "value":  dataUrl});
                }
            }
            var resource;
            if (requests[i].item.type === 'wms') {
                var wmsString = "?service=WMS&version=1.1.1&request=GetMap&width=256&height=256&format=image/png";
                resource = {
                    "wms_layer": requests[i].item.layers, 
                    "wms_api_url": requests[i].item.url, 
                    "url": requests[i].item.url+wmsString+'&layers='+requests[i].item.layers+'&bbox='+bboxString, 
                    "format": "WMS", 
                    "name": "WMS link",
                };
            } else if (requests[i].item.type === 'esri-mapService') {
                resource = {
                    "url": requests[i].item.url, 
                    "format": "Esri REST", 
                    "name": "ESRI REST link"
                };
            }
            ckanRequests.push({
                "url": ckanServer + '/api/3/action/package_' + (found ? 'update' : 'create'),
                "data" : {
                    "name": getCkanName(requests[i].item.name), 
                    "title": requests[i].item.name, 
                    "license_id": "cc-by", 
                    "notes": requests[i].item.description, 
                    "owner_org": getCkanName(requests[i].owner_org),
                    "groups": [ { "name": getCkanName(requests[i].group) } ],
                    "extras": extrasList,
                    "resources": [ resource ]
                }
            });
        }

        var currentIndex = 0;
        console.log('Starting ckan tasks:', ckanRequests.length);
        var sendNext = function() {
            if (currentIndex < ckanRequests.length) {
                postToCkan(
                    ckanRequests[currentIndex].url, 
                    ckanRequests[currentIndex].data, 
                    function() { 
                        currentIndex++;
                        if ((currentIndex % 5) === 0 || currentIndex === ckanRequests.length) {
                            console.log('Completed', currentIndex, 'ckan tasks out of', ckanRequests.length);
                        }
                        sendNext(); 
                    },
                    ckanApiKey
                );
            }
        };
        sendNext();
    });
}


module.exports = ToolsPanelViewModel;
