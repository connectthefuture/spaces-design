/*
 * Copyright (c) 2014 Adobe Systems Incorporated. All rights reserved.
 *  
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), 
 * to deal in the Software without restriction, including without limitation 
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the 
 * Software is furnished to do so, subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *  
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 * DEALINGS IN THE SOFTWARE.
 * 
 */

define(function (require, exports) {
    "use strict";

    var Promise = require("bluebird"),
        Immutable = require("immutable");

    var descriptor = require("adapter").ps.descriptor,
        layerLib = require("adapter").lib.layer,
        documentLib = require("adapter").lib.document,
        generatorLib = require("adapter").lib.generator,
        preferenceLib = require("adapter").lib.preference;

    var dialog = require("./dialog"),
        preferences = require("./preferences"),
        events = require("js/events"),
        locks = require("js/locks"),
        globalUtil = require("js/util/global"),
        objUtil = require("js/util/object"),
        collection = require("js/util/collection"),
        nls = require("js/util/nls"),
        log = require("js/util/log"),
        global = require("js/util/global"),
        ExportAsset = require("js/models/exportasset"),
        ExportService = require("js/util/exportservice"),
        policyActions = require("js/actions/policy"),
        headlights = require("js/util/headlights"),
        exportStore = require("js/stores/export");

    /**
     * An instance of the ExportService utility used to communicate with the generator plugin
     * @private
     * @type {ExportService}
     */
    var _exportService;

    /**
     * The previous folder into which assets were saved.
     * If populated, initialize the OS folder chooser here
     * @type {?string}
     */
    var _lastFolderPath = null;

    /**
     * List of actively running export jobs
     *
     * @type {Immutable.Iterable.<Promise>}
     */
    var _activeExports = null;

    /**
     * Fetch relevant data from both the document and export stores, and sync the metadata to
     * the photoshop "extension data".  If layerID is not supplied, then only document level 
     * metadata is synced
     *
     * Note that the underlying adapter API to setExtensionData requires the full data structure to be supplied
     * which is why we are always fetching directly from both stores prior to calling setExtensionData
     *
     * @private
     * @param {number} documentID
     * @param {Immutable.Iterable.<number>=} layerIDs Optional. If not supplied, sync doc-level metadata
     * @param {boolean=} suppressHistory Optional, if truthy then do not supply photoshop with historyStateInfo
     * @return {Promise}
     */
    var _syncExportMetadata = function (documentID, layerIDs, suppressHistory) {
        var documentExports = this.flux.stores.export.getDocumentExports(documentID),
            document = this.flux.stores.document.getDocument(documentID),
            playObjects;

        if (!documentExports || !document) {
            throw new Error("Can not find Document or DocumentExports with ID " + documentID);
        }

        // helper to build play object for  individual layers
        var _buildPlayObject = function (layerID) {
            var layerExports = documentExports.getLayerExports(layerID),
                layerExportsArray = layerExports.toJS(),
                layer = document.layers.byID(layerID);

            if (!document || !layer) {
                throw new Error("Could not find Layer for doc:" + documentID + ", layer:" + layerID);
            }

            var exportsMetadata = {
                exportAssets: layerExportsArray,
                exportEnabled: !!layer.exportEnabled
            };

            // set layer extension data
            return layerLib.setExtensionData(documentID,
                layerID, global.EXTENSION_DATA_NAMESPACE, "exportsMetadata", exportsMetadata);
        };

        var playOptions = suppressHistory ? undefined : {
            historyStateInfo: {
                name: nls.localize("strings.ACTIONS.MODIFY_EXPORT_ASSETS"),
                target: documentLib.referenceBy.id(documentID)
            }
        };

        // prepare play objects for document or layer level, based on existence of layerIDs
        if (layerIDs) {
            playObjects = layerIDs.map(_buildPlayObject).toArray();
        } else {
            var exportsMetadata = {
                exportAssets: documentExports.rootExports.toJS()
            };

            // set document extension data
            playObjects = [documentLib.setExtensionData(documentID,
                global.EXTENSION_DATA_NAMESPACE, "exportsMetadata", exportsMetadata)];
        }

        return descriptor.batchPlayObjects(playObjects, playOptions);
    };

    /**
     * Update the status of all assets that are being requested
     * This update does not get synced to PS metadata
     *
     * @param {number} documentID
     * @param {Immutable.Iterable.<number>=} layerIDs
     * @return {Promise}
     */
    var _setAssetsRequested = function (documentID, layerIDs) {
        var payload = { documentID: documentID };

        if (layerIDs) {
            payload.layerIDs = layerIDs;
        }

        return this.dispatchAsync(events.export.SET_AS_REQUESTED, payload);
    };

    /**
     * Helper function to export a single asset using the export service, and update the metadata afterwards.
     *
     * When the export service's promise is resolved, a fresh flux action is called
     * to perform the metadata sync (to wit: it does not transfer to updateExportAsset).
     * This is because the websocket export call is asynchronous, and should not be handled within the
     * action that initiates the export.  This is analogous to handling photoshop events with a flux action,
     * except that here we are not listening to an event,
     * but rather keeping an unfulfilled promise in the action's state
     *
     * @private
     * @param {Document} document
     * @param {Layer=} layer If not supplied, this is a document-level asset
     * @param {number} assetIndex index of this asset within the layer's list
     * @param {ExportAsset} asset asset to export
     * @param {string=} baseDir Optional directory path in to which assets should be exported
     * @param {string=} baseFilename Base file name to which things may be prefixed/suffixed
     * @param {string=} prefix Optional prefix to apply to the baseFilename
     * @return {Promise}
     */
    var _exportAsset = function (document, layer, assetIndex, asset, baseDir, baseFilename, prefix) {
        var _layers = layer ? Immutable.List.of(layer) : null,
            filename = (prefix ? prefix + "-" : "") +
                (baseFilename || nls.localize("strings.EXPORT.EXPORT_DOCUMENT_FILENAME")) +
                asset.suffix;

        headlights.logEvent("export", "asset", "scale-" + asset.scale + "-setting-" + asset.format);

        return _exportService.exportAsset(document, layer, asset, filename, baseDir)
            .bind(this)
            .then(
                function (pathArray) {
                    // Do we need to be aware of exports that return >1 file path?
                    var assetProps = {
                        filePath: pathArray[0],
                        status: ExportAsset.STATUS.STABLE
                    };
                    this.flux.actions.export.updateExportAsset(document, _layers, assetIndex, assetProps,
                        true, true);
                },
                function (e) {
                    log.error("Export Failed for asset %d of layerID %d, documentID %d, with error: ",
                        assetIndex, layer && layer.id, document.id, e);

                    var assetProps = {
                        filePath: "",
                        status: ExportAsset.STATUS.ERROR
                    };

                    this.flux.actions.export.updateExportAsset(document, _layers, assetIndex, assetProps,
                        true, true);
                })
            .catch(function (e) {
                log.error("Export Failed to update asset after export: %d of layerID %d, documentID %d, with error: ",
                    assetIndex, layer && layer.id, document.id, e);
            });
    };

    /**
     * Store a promise in state that will resolve when all given export promises
     * are resolved or any are rejected
     * 
     * @param {Immutable.Iterable.<Promise>} exportList
     */
    var _batchExports = function (exportList) {
        if (_activeExports) {
            throw new Error("Can't start a batch export while one is already active");
        }

        _activeExports = Promise.all(exportList.toArray())
            .bind(this)
            .catch(function (err) {
                log.error("There were errors while exporting", err);
            })
            .finally(function () {
                _activeExports = null;
                return _setServiceBusy.call(this, false);
            });
    };

    /**
     * Insert an asset (or assets) into a document or set of layers, by inserting into the existing list
     * at the given index.
     * Sync to PS metadata afterwards
     *
     * @private
     * @param {Document} document
     * @param {Immutable.Iterable.<Layer>=} layers if not supplied, then doc-level assets
     * @param {number} assetIndex index of this asset within the layer's list to append props 
     * @param {object|Array.<object>} props ExportAsset-like properties to be merged, or an array thereof
     * @return {Promise}
     */
    var _insertAssetsAtIndex = function (document, layers, assetIndex, props) {
        var documentID = document.id,
            layerIDs = layers && collection.pluck(layers, "id") || undefined,
            assetPropsArray = Array.isArray(props) ? props : [props];

        var payload = {
            documentID: documentID,
            layerIDs: layerIDs,
            assetPropsArray: assetPropsArray,
            assetIndex: assetIndex,
            history: {
                newState: true,
                name: nls.localize("strings.ACTIONS.MODIFY_EXPORT_ASSETS")
            }
        };

        return this.dispatchAsync(events.export.history.ASSET_ADDED, payload)
            .bind(this)
            .then(function () {
                return _syncExportMetadata.call(this, documentID, layerIDs);
            });
    };

    /**
     * Get current status of generator
     * @private
     * @return {Promise.<boolean>}
     */
    var _getGeneratorStatus = function () {
        return descriptor.playObject(generatorLib.getGeneratorStatus())
            .then(function (status) {
                return objUtil.getPath(status, "generatorStatus.generatorStatus") === 1;
            })
            .catch(function (e) {
                log.error("Failed to determine generator status: %s", e.message);
                return false;
            });
    };

    /**
     * Enable/Disable generator based on supplied parameter
     * @private
     * @param {boolean} enabled
     * @return {Promise}
     */
    var _setGeneratorStatus = function (enabled) {
        return descriptor.playObject(generatorLib.setGeneratorStatus(enabled))
            .catch(function (e) {
                throw new Error("Could not enable generator: " + e.message);
            });
    };

    /**
     * Get the port number of the generator plugin, as stored in the photoshop custom preferences
     *
     * @return {Promise.<?string>}
     */
    var _getWebSocketPort = function () {
        var prefKey = ExportService.domainPrefKey;

        return descriptor.playObject(preferenceLib.getCustomPreference(prefKey))
            .then(function (pref) {
                var settings = JSON.parse(objUtil.getPath(pref, prefKey + ".settings") || null),
                    port = settings && settings.websocketServerPort;
                log.debug("Export: Found configured port: " + port); // TEMP
                return port;
            })
            .catch(function (e) {
                log.error("Failed to retrieve custom preference [" + prefKey + "]: " + e.message);
                return null;
            });
    };

    /**
     * Update the export store with the new service busy flag;
     *
     * @param {boolean} busy
     * @return {Promise}
     */
    var _setServiceBusy = function (busy) {
        return this.dispatchAsync(events.export.SET_STATE_PROPERTY, { serviceBusy: !!busy });
    };

    /**
     * Open the export modal dialog
     *
     * @return {Promise}
     */
    var openExportPanel = function () {
        return this.transfer(dialog.openDialog, exportStore.EXPORT_DIALOG_ID);
    };
    openExportPanel.action = {
        reads: [],
        writes: [],
        modal: true,
        transfers: [dialog.openDialog]
    };

    /**
     * Close the export modal dialog
     *
     * @return {Promise}
     */
    var closeExportPanel = function () {
        return this.transfer(dialog.closeDialog, exportStore.EXPORT_DIALOG_ID);
    };
    closeExportPanel.action = {
        reads: [],
        writes: [],
        modal: true,
        transfers: [dialog.closeDialog]
    };

    /**
     * Merge the given set of asset properties into the Export Asset model and persist in the the Ps metadata
     * If layers is empty, or not supplied, treat this as document root level asset
     *
     * If an array of props are supplied then they are added to the list beginning at the supplied index.
     *
     * @param {Document} document
     * @param {Immutable.Iterable.<Layer>=} layers set of selected layers
     * @param {number} assetIndex index of this asset within the layer's list to append props 
     * @param {object|Array.<object>} props ExportAsset-like properties to be merged, or an array thereof
     * @param {boolean=} suppressHistory Optional, if truthy then do not supply photoshop with historyStateInfo
     * @param {boolean=} suppressErrors Optional, if truthy then swallow any errors
     * @return {Promise}
     */
    var updateExportAsset = function (document, layers, assetIndex, props, suppressHistory, suppressErrors) {
        var documentID = document.id,
            layerIDs = layers && layers.size > 0 && collection.pluck(layers, "id") || undefined,
            assetPropsArray = Array.isArray(props) ? props : [props],
            shiftedPropsArray = new Array(assetIndex + 1),
            payload;

        shiftedPropsArray.splice.apply(shiftedPropsArray,
            [assetIndex, assetPropsArray.length].concat(assetPropsArray));

        payload = {
            documentID: documentID,
            layerIDs: layerIDs,
            assetPropsArray: shiftedPropsArray,
            history: {
                newState: true,
                name: nls.localize("strings.ACTIONS.MODIFY_EXPORT_ASSETS")
            }
        };

        var event = suppressHistory ?
            events.export.ASSET_CHANGED :
            events.export.history.ASSET_CHANGED;

        return this.dispatchAsync(event, payload)
            .bind(this)
            .then(function () {
                return _syncExportMetadata.call(this, documentID, layerIDs, suppressHistory);
            })
            .catch(function (e) {
                if (suppressErrors) {
                    log.debug("updateExportAsset failed, but ignoring it", e);
                } else {
                    var message = e instanceof Error ? (e.stack || e.message) : e;
                    throw new Error("Failed to update asset: " + message);
                }
            });
    };
    updateExportAsset.action = {
        reads: [locks.JS_DOC],
        writes: [locks.JS_EXPORT, locks.PS_DOC],
        modal: true
    };

    /**
     * Set the numerical scale of the asset specified by the given index
     *
     * @param {Document} document
     * @param {Immutable.List.<Layer>=} layers
     * @param {number} assetIndex index of this asset within the layer's list
     * @param {number} scale
     * @return {Promise}
     */
    var updateLayerAssetScale = function (document, layers, assetIndex, scale) {
        return this.transfer(updateExportAsset, document, layers, assetIndex, { scale: scale || 1 });
    };
    updateLayerAssetScale.action = {
        reads: [],
        writes: [],
        modal: true,
        transfers: [updateExportAsset]
    };

    /**
     * Set the filename suffix of the asset specified by the given index
     *
     * @param {Document} document
     * @param {Immutable.List.<Layer>=} layers
     * @param {number} assetIndex index of this asset within the layer's list
     * @param {string} suffix
     * @return {Promise}
     */
    var updateLayerAssetSuffix = function (document, layers, assetIndex, suffix) {
        return this.transfer(updateExportAsset, document, layers, assetIndex, { suffix: suffix });
    };
    updateLayerAssetSuffix.action = {
        reads: [],
        writes: [],
        modal: true,
        transfers: [updateExportAsset]
    };

    /**
     * Set the format of the asset specified by the given index
     *
     * @param {Document} document
     * @param {Immutable.List.<Layer>=} layers
     * @param {number} assetIndex index of this asset within the layer's list
     * @param {string} format (example: jpg)
     * @return {Promise}
     */
    var updateLayerAssetFormat = function (document, layers, assetIndex, format) {
        return this.transfer(updateExportAsset, document, layers, assetIndex, { format: format });
    };
    updateLayerAssetFormat.action = {
        reads: [],
        writes: [],
        modal: true,
        transfers: [updateExportAsset]
    };

    /**
     * Adds an asset, or assets, to the end of the document's root asset list, or to that of a set of layers.
     * If props not provided, choose the next reasonable scale and create an otherwise vanilla asset
     *
     * Recognizes an empty list of layers as implying doc-level export
     *
     * Layer-level exports:
     * Will only add assets to those layers which are supported.
     * Adds assets after the last uniform asset shared by the given set of layers.
     *
     * @param {Document} document
     * @param {DocumentExports} documentExports
     * @param {Immutable.List.<Layer>} layers
     * @param {object|Array.object=} props asset-like object, or an array thereof.  if not supplied, picks next scale
     * @return {Promise}
     */
    var addAsset = function (document, documentExports, layers, props) {
        var updatePromise,
            exportsList,
            assetIndex,
            _props,
            _layers;

        if (layers.size > 0) {
            var supportedLayers = document.layers.filterExportable(layers);

            exportsList = documentExports.getUniformAssetsOnly(supportedLayers);
            assetIndex = documentExports.getLastUniformAssetIndex(supportedLayers) + 1;
            _layers = supportedLayers;
        } else {
            exportsList = documentExports.rootExports;
            assetIndex = exportsList.size;
        }

        // If not supplied, set a default asset based on the next scale in the list that doesn't already exist
        if (!props) {
            var existingScales = (exportsList && collection.pluck(exportsList, "scale")) || Immutable.List(),
                remainingScales = collection.difference(ExportAsset.SCALES, existingScales),
                nextScale = remainingScales.size > 0 ? remainingScales.first() : ExportAsset.SCALES.first();

            _props = { scale: nextScale };
        } else {
            _props = props;
        }

        // For layer-level exports, force exportEnabled=true before adding assets?
        if (_layers) {
            var payload = {
                documentID: document.id,
                layerIDs: collection.pluck(_layers, "id"),
                exportEnabled: true
            };
            updatePromise = this.dispatchAsync(events.document.history.LAYER_EXPORT_ENABLED_CHANGED, payload);
        } else {
            updatePromise = Promise.resolve();
        }

        // Since updateLayerExport handles the metadata sync, we must be sure that the layer model is updated first
        return updatePromise
            .bind(this)
            .then(function () {
                return _insertAssetsAtIndex.call(this, document, _layers, assetIndex, _props);
            });
    };
    addAsset.action = {
        reads: [locks.JS_DOC],
        writes: [locks.JS_EXPORT, locks.PS_DOC],
        transfers: []
    };

    /**
     * Add a default export asset to the layer specified by layerID, if it doesn't already have any assets.
     * If no layerID is supplied, add to the first artboard if it exists.
     * Does not create a history state
     *
     * @param {number} documentID
     * @param {number=} layerID
     */
    var addDefaultAsset = function (documentID, layerID) {
        var documentExports = this.flux.stores.export.getDocumentExports(documentID, true),
            document = this.flux.stores.document.getDocument(documentID);

        if (!document) {
            return Promise.reject(new Error("Can not find document " + documentID + " to addDefaultAsset"));
        }

        var layer = layerID ? document.layers.byID(layerID) : document.layers.artboards.first(),
            layerExports = layer && documentExports.getLayerExports(layer.id);

        if (layer && (!layerExports || layerExports.isEmpty())) {
            var payload = {
                documentID: documentID,
                layerIDs: Immutable.List.of(layer.id),
                exportEnabled: true
            };
            return this.dispatchAsync(events.document.history.LAYER_EXPORT_ENABLED_CHANGED, payload)
                .bind(this)
                .then(function () {
                    return this.transfer(updateExportAsset, document, Immutable.List.of(layer), 0, {}, true);
                });
        } else {
            return Promise.resolve();
        }
    };
    addDefaultAsset.action = {
        reads: [locks.JS_DOC, locks.JS_EXPORT],
        writes: [],
        modal: true,
        transfers: [updateExportAsset]
    };

    /**
     * Delete the Export Asset configuration specified by the given index
     *
     * If layers is empty, or not supplied, delete a document-level asset
     *
     * @param {Document} document
     * @param {Immutable.Iterable.<Layer>=} layers
     * @param {number} assetIndex index of this asset within the layer's list
     * @return {Promise}
     */
    var deleteExportAsset = function (document, layers, assetIndex) {
        var documentID = document.id,
            layerIDs = layers && layers.size > 0 && collection.pluck(layers, "id") || undefined,
            payload = {
                documentID: documentID,
                layerIDs: layerIDs,
                assetIndex: assetIndex,
                history: {
                    newState: true,
                    name: nls.localize("strings.ACTIONS.MODIFY_EXPORT_ASSETS")
                }
            };

        return this.dispatchAsync(events.export.history.DELETE_ASSET, payload)
            .bind(this)
            .then(function () {
                return _syncExportMetadata.call(this, documentID, layerIDs);
            });
    };
    deleteExportAsset.action = {
        reads: [locks.JS_DOC],
        writes: [locks.JS_EXPORT, locks.PS_DOC]
    };

    /**
     * Sets the exportEnabled flag for a given layer or layers
     *
     * For any layer without assets, create a default asset on the fly when exportEnabled is true
     *
     * @private
     * @param {Document} document Owner document
     * @param {Layer|Immutable.List.<Layer>} layers Either a Layer reference or array of Layers
     * @param {boolean=} exportEnabled
     * @return {Promise}
     */
    var setLayerExportEnabled = function (document, layers, exportEnabled) {
        var _layers = Immutable.List.isList(layers) ?
                layers :
                Immutable.List.of(layers);

        var layersWithoutExports,
            quickAddPromise;

        // If enabling layers, determine if any them need a default asset created
        if (exportEnabled) {
            var documentExports = this.flux.stores.export.getDocumentExports(document.id);

            layersWithoutExports = documentExports.filterLayersWithoutExports(_layers);
            if (layersWithoutExports.size > 0) {
                quickAddPromise = this.transfer(addAsset, document, documentExports, layersWithoutExports);
            } else {
                quickAddPromise = Promise.resolve();
            }
        } else {
            quickAddPromise = Promise.resolve();
        }

        if (!layersWithoutExports || _layers.size > layersWithoutExports.size) {
            var layerIDs = collection.pluck(_layers, "id"),
                payload = {
                    documentID: document.id,
                    layerIDs: layerIDs,
                    exportEnabled: exportEnabled
                };

            return quickAddPromise
                .bind(this)
                .then(function () {
                    return this.dispatchAsync(events.document.history.LAYER_EXPORT_ENABLED_CHANGED, payload);
                })
                .then(function () {
                    return _syncExportMetadata.call(this, document.id, layerIDs, true);
                });
        } else {
            // Special case: enabling layers, and ALL of them got default assets enabled
            return quickAddPromise;
        }
    };
    setLayerExportEnabled.action = {
        reads: [],
        writes: [locks.JS_DOC, locks.PS_DOC],
        transfers: [addAsset]
    };

    /**
     * Update the export store with the new service availability flag;
     *
     * @param {boolean} available
     * @return {Promise}
     */
    var setServiceAvailable = function (available) {
        return this.dispatchAsync(events.export.SERVICE_STATUS_CHANGED, { serviceAvailable: !!available });
    };
    setServiceAvailable.action = {
        reads: [],
        writes: [locks.JS_EXPORT],
        modal: true
    };

    /**
     * Prompt the user to choose a folder by opening an OS dialog.
     * Keyboard policies are temporarily disabled while the dialog is open.
     * Resolves with null if the user cancels
     *
     * @return {Promise.<?string>} Promise of a File Path of the chosen folder
     */
    var promptForFolder = function () {
        return this.transfer(policyActions.suspendAllPolicies)
            .bind(this)
            .then(
                function () {
                    return _exportService.promptForFolder(_lastFolderPath || "~");
                },
                function (e) {
                    throw new Error("Failed to stash keyboard policies prior to opening OS dialog: " + e.message);
                }
            )
            .finally(function () {
                return this.transfer(policyActions.restoreAllPolicies);
            });
    };
    promptForFolder.action = {
        reads: [],
        writes: locks.ALL_LOCKS,
        transfers: [policyActions.suspendAllPolicies, policyActions.restoreAllPolicies]
    };

    /**
     * Export all layer assets for the given document for which export has been enabled (layer.exportEnabled)
     * 
     * Or, if layers is supplied, export only those layers' assets
     * and disregard the layer's exportEnabled value
     *
     * @param {Document} document
     * @param {Immutable.Iterable.<Layer>=} layers Optional.  If not supplied export all exportEnabled layers
     * @param {Immutable.Map.<number, string>=} prefixMap Optional map of layerID > asset prefix
     * @return {Promise} Resolves when all assets have been exported, or if canceled via the file chooser
     */
    var exportLayerAssets = function (document, layers, prefixMap) {
        if (_activeExports) {
            Promise.reject(new Error("Can not export assets while another batch job in progress"));
        }

        if (!document) {
            Promise.resolve("No Document");
        }

        if (!_exportService || !_exportService.ready()) {
            return this.transfer(setServiceAvailable, false);
        }

        var documentID = document.id,
            documentExports = this.flux.stores.export.getDocumentExports(documentID, true),
            layersList,
            quickAddPromise;

        if (layers) {
            // Filter only the exportable ones from the provided set of layers
            layersList = document.layers.filterExportable(layers);

            // Add a default asset added to any layers that need it
            var layersWithoutExports = documentExports.filterLayersWithoutExports(layersList);
            if (layersWithoutExports.isEmpty()) {
                quickAddPromise = Promise.resolve();
            } else {
                quickAddPromise = this.transfer(addAsset, document, documentExports, layersWithoutExports);
            }
        } else {
            // No layers provided, so get all layers that have exports configured and which are "exportEnabled"
            layersList = documentExports.getLayersWithExports(document, undefined, true);
            layersList = document.layers.filterExportable(layersList);
            quickAddPromise = Promise.resolve();
        }

        // prompt for folder and then export to the result.
        // resolve immediately if no folder is returned
        return this.transfer(promptForFolder)
            .bind(this)
            .then(function (baseDir) {
                if (!baseDir) {
                    return Promise.resolve();
                }

                _lastFolderPath = baseDir;

                var layerIdList = collection.pluck(layersList, "id");

                return _setAssetsRequested.call(this, document.id, layerIdList)
                    .bind(this)
                    .then(_setServiceBusy.bind(this, true))
                    .return(quickAddPromise)
                    .then(function () {
                        // fetch documentExports anew, in case quick-add added any assets
                        var documentExports = this.flux.stores.export.getDocumentExports(documentID, true),
                            baseNameCountMap = new Map();

                        // Iterate over the layers, find the associated export assets, and export them
                        var exportList = layersList.flatMap(function (layer) {
                            var filename = layer.name,
                                prefix = prefixMap && prefixMap.get(layer.id);

                            // Avoid naming collision by suffixing filename if a same-named layer
                            // has already been processed
                            if (baseNameCountMap.has(filename)) {
                                var count = baseNameCountMap.get(filename) + 1;

                                baseNameCountMap.set(filename, count);
                                filename = filename + " " + count;
                            } else {
                                baseNameCountMap.set(filename, 1);
                            }

                            return documentExports.getLayerExports(layer.id)
                                .map(function (asset, index) {
                                    return _exportAsset.call(this, document, layer,
                                        index, asset, _lastFolderPath, filename, prefix);
                                }, this);
                        }, this);

                        _batchExports.call(this, exportList);
                        return Promise.resolve();
                    });
            });
    };
    exportLayerAssets.action = {
        reads: [locks.JS_DOC],
        writes: [locks.JS_EXPORT],
        modal: true,
        transfers: [promptForFolder, addAsset, setServiceAvailable]
    };

    /**
     * Export all document-level assets for the given document
     *
     * @param {Document} document
     * @return {Promise} resolves when all assets have been exported
     */
    var exportDocumentAssets = function (document) {
        if (!document) {
            return Promise.resolve("No Document");
        }

        if (!_exportService || !_exportService.ready()) {
            return this.transfer(setServiceAvailable, false);
        }

        var documentExports = this.flux.stores.export.getDocumentExports(document.id, true),
            quickAddPromise;

        // Add a default asset if necessary
        if (!documentExports.rootExports.isEmpty()) {
            quickAddPromise = Promise.resolve();
        } else {
            quickAddPromise = this.transfer(addAsset, document, documentExports, Immutable.List());
        }

        // prompt for folder and then export to the result.
        // resolve immediately if no folder is returned
        var promptPromise = this.transfer(promptForFolder);

        return Promise.join(promptPromise, quickAddPromise, function (baseDir) {
            if (!baseDir) {
                return Promise.resolve();
            }

            _lastFolderPath = baseDir;

            return _setAssetsRequested.call(this, document.id)
                .bind(this)
                .then(_setServiceBusy.bind(this, true))
                .then(function () {
                    // fetch documentExports anew, in case quick-add added any assets
                    var documentExports = this.flux.stores.export.getDocumentExports(document.id, true),
                        filename = document.nameWithoutExtension;

                    // Iterate over the root document assets, and export them
                    var exportList = documentExports.rootExports.map(function (asset, index) {
                        return _exportAsset.call(this, document, null, index, asset, _lastFolderPath, filename);
                    }, this);

                    _batchExports.call(this, exportList);
                    return Promise.resolve();
                });
        }.bind(this));
    };
    exportDocumentAssets.action = {
        reads: [locks.JS_DOC, locks.JS_EXPORT],
        writes: [],
        modal: true,
        transfers: [promptForFolder, addAsset, setServiceAvailable]
    };
    
    /**
     * Copy file from one location to another.
     *
     * @param {string} sourcePath
     * @param {string} targetPath
     * @return {Promise} 
     */
    var copyFile = function (sourcePath, targetPath) {
        if (!_exportService || !_exportService.ready()) {
            return this.transfer(setServiceAvailable, false);
        }

        return _exportService.copyFile(sourcePath, targetPath);
    };
    copyFile.action = {
        reads: [],
        writes: [],
        modal: true,
        transfers: [setServiceAvailable]
    };
    
    /**
     * Delete files at specific locations.
     *
     * @param {Array.<string>} filePaths
     * @return {Promise}
     */
    var deleteFiles = function (filePaths) {
        if (!_exportService || !_exportService.ready()) {
            return this.transfer(setServiceAvailable, false);
        }

        return _exportService.deleteFiles(filePaths);
    };
    deleteFiles.action = {
        reads: [],
        writes: [],
        modal: true,
        transfers: [setServiceAvailable]
    };

    /**
     * Update the both the store state, and the preferences, with useArtboardPrefix
     *
     * @param {boolean} enabled
     * @return {Promise}
     */
    var setUseArtboardPrefix = function (enabled) {
        var dispatchPromise = this.dispatchAsync(events.export.SET_STATE_PROPERTY, { useArtboardPrefix: enabled }),
            prefPromise = this.transfer(preferences.setPreference, "exportUseArtboardPrefix", enabled);

        return Promise.join(dispatchPromise, prefPromise);
    };
    setUseArtboardPrefix.action = {
        reads: [],
        writes: [locks.JS_EXPORT, locks.JS_PREF],
        modal: true,
        transfers: [preferences.setPreference]
    };

    /**
     * After start up, ensure that generator is enabled, and then initialize the export service
     *
     * If in debug mode, do a pre check in case we're using a remote connection generator
     * 
     * @return {Promise}
     */
    var afterStartup = function () {
        // helper function to wait for the service init, and set the service "available" in our store
        var _initService = function () {
            return _exportService.init()
                .bind(this)
                .then(function () {
                    log.debug("Export: Generator plugin connection established");
                    this.flux.actions.export.setServiceAvailable(true);
                })
                .return(true);
        }.bind(this);

        // In debug mode we should first do an abbreviated test
        // to see if the plugin is already running (perhaps on a remote generator connection)
        var _preCheck = function () {
            if (globalUtil.debug) {
                return _getWebSocketPort()
                    .then(function (port) {
                        _exportService = new ExportService(port, true); // quickCheck mode
                        return _initService();
                    })
                    .catch(function () {
                        _exportService = null;
                        return false;
                    });
            } else {
                return Promise.resolve(false);
            }
        };

        // helper to enabled generator if necessary and then init exportService
        var _enableAndConnect = function () {
            return _getGeneratorStatus()
                .then(function (enabled) {
                    if (!enabled) {
                        log.debug("Export: Starting Generator...");
                        return _setGeneratorStatus(true);
                    }
                    return false;
                })
                .then(function (generatorJustStarted) {
                    if (generatorJustStarted) {
                        // ONLY IF we are having to force enable generator, which shouldn't be often
                        // The new port isn't configured immediately, and start up is not synchronous
                        // This is partially caused by the race in generator-core startWebsocketServer
                        return Promise.delay(3000).then(_getWebSocketPort);
                    } else {
                        return _getWebSocketPort();
                    }
                })
                .then(function (port) {
                    _exportService = new ExportService(port);
                    return _initService();
                });
        };

        return _preCheck()
            .then(function (preCheckResult) {
                return preCheckResult ||
                    _enableAndConnect().catch(function (e) {
                        log.debug("Export: failed to connect the first time (going to try one more): " + e.message);
                        _exportService = null;
                        return false;
                    });
            })
            .then(function (enabled) {
                if (!enabled) {
                    // Try one more time, in case the PORT has changed and the PS configuration lagged
                    return _enableAndConnect();
                }
            })
            .bind(this)
            .tap(function () {
                var useArtboardPrefix = this.flux.stores.preferences.getState().get("exportUseArtboardPrefix", false);
                
                return this.dispatchAsync(events.export.SET_STATE_PROPERTY, { useArtboardPrefix: useArtboardPrefix });
            })
            .catch(function (e) {
                log.error("Export Service failed to initialize.  Giving Up.  Cause: " + e.message);
                return false;
            });
    };
    afterStartup.action = {
        reads: [],
        writes: [],
        modal: true
    };

    /**
     * Handle the standard onReset action
     *
     * @return {Promise}
     */
    var onReset = function () {
        _lastFolderPath = null;
        _activeExports = null;

        if (!_exportService) {
            return Promise.resolve();
        }

        return _exportService.close()
            .finally(function () {
                _exportService = null;
            });
    };
    onReset.action = {
        reads: [],
        writes: []
    };

    exports.openExportPanel = openExportPanel;
    exports.closeExportPanel = closeExportPanel;
    exports.updateExportAsset = updateExportAsset;
    exports.updateLayerAssetScale = updateLayerAssetScale;
    exports.updateLayerAssetSuffix = updateLayerAssetSuffix;
    exports.updateLayerAssetFormat = updateLayerAssetFormat;
    exports.addAsset = addAsset;
    exports.addDefaultAsset = addDefaultAsset;
    exports.deleteExportAsset = deleteExportAsset;
    exports.setLayerExportEnabled = setLayerExportEnabled;
    exports.setServiceAvailable = setServiceAvailable;
    exports.promptForFolder = promptForFolder;
    exports.exportLayerAssets = exportLayerAssets;
    exports.exportDocumentAssets = exportDocumentAssets;
    exports.setUseArtboardPrefix = setUseArtboardPrefix;
    exports.afterStartup = afterStartup;
    
    exports.copyFile = copyFile;
    exports.deleteFiles = deleteFiles;

    exports.onReset = onReset;
});
