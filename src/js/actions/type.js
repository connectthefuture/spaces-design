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
        _ = require("lodash");

    var textLayerLib = require("adapter/lib/textLayer"),
        descriptor = require("adapter/ps/descriptor"),
        documentLib = require("adapter/lib/document"),
        layerLib = require("adapter/lib/layer"),
        appLib = require("adapter/lib/application");

    var layerActions = require("./layers"),
        events = require("../events"),
        locks = require("js/locks"),
        collection = require("js/util/collection"),
        locking = require("js/util/locking"),
        math = require("js/util/math"),
        strings = require("i18n!nls/strings"),
        layerActionsUtil = require("js/util/layeractions"),
        synchronization = require("js/util/synchronization");

    /**
     * Minimum and maximum Photoshop-supported font sizes
     * 
     * @const
     * @type {number} 
     */
    var PS_MIN_FONT_SIZE = 0.04,
        PS_MAX_FONT_SIZE = 5400;

    /**
     * play/batchPlay options that allow the canvas to be continually updated, 
     * and history state to be consolidated 
     *
     * @private
     * @param {number} documentID
     * @param {string} name localized name to put into the history state
     * @param {boolean} modal is the app in a modal state
     * @param {boolean=} coalesce Whether to coalesce this operations history state
     * @param {object=} options Inherited into the type options returned, if present
     * @return {object} options
     */
    var _getTypeOptions = function (documentID, name, modal, coalesce, options) {
        var typeOptions = {
            paintOptions: {
                immediateUpdate: true,
                quality: "draft"
            },
            canExecuteWhileModal: true,
            ignoreTargetWhenModal: true
        };

        if (!modal) {
            typeOptions.historyStateInfo = {
                name: name,
                target: documentLib.referenceBy.id(documentID),
                coalesce: !!coalesce,
                suppressHistoryStateNotification: !!coalesce
            };
        }

        return _.merge({}, options, typeOptions);
    };

    /**
     * Update the post script (in terms of a type family and type style) of the given
     * layers in the given document.
     *
     * @param {Document} document
     * @param {Immutable.Iterable.<Layers>} layers
     * @param {string} postscript Post script name of the described typeface
     * @param {string} family The type face family name, e.g., "Helvetica Neue"
     * @param {string} style The type face style name, e.g., "Oblique"
     * @return {Promise}
     */
    var updatePostScript = function (document, layers, postscript, family, style) {
        var layerIDs = collection.pluck(layers, "id"),
            payload = {
                documentID: document.id,
                layerIDs: layerIDs,
                postscript: postscript,
                family: family,
                style: style
            };

        return this.dispatchAsync(events.document.TYPE_FACE_CHANGED, payload);
    };
    updatePostScript.reads = [];
    updatePostScript.writes = [locks.JS_DOC];
    updatePostScript.modal = true;

    /**
     * Set the post script (in terms of a type family and type style) of the given
     * layers in the given document. This triggers a layer bounds update.
     *
     * @param {Document} document
     * @param {Immutable.Iterable.<Layers>} layers
     * @param {string} postscript Post script name of the described typeface
     * @param {string} family The type face family name, e.g., "Helvetica Neue"
     * @param {string} style The type face style name, e.g., "Oblique"
     * @return {Promise}
     */
    var setPostScript = function (document, layers, postscript, family, style) {
        var layerIDs = collection.pluck(layers, "id"),
            layerRefs = layerIDs.map(textLayerLib.referenceBy.id).toArray(),
            modal = this.flux.store("tool").getModalToolState();

        var setFacePlayObject = textLayerLib.setPostScript(layerRefs, postscript),
            typeOptions = _getTypeOptions(document.id, strings.ACTIONS.SET_TYPE_FACE, modal),
            setFacePromise = locking.playWithLockOverride(document, layers, setFacePlayObject, typeOptions),
            updatePromise = this.transfer(updatePostScript, document, layers, postscript, family, style);

        return Promise.join(updatePromise, setFacePromise)
            .bind(this)
            .then(function () {
                if (!modal) {
                    var anylayerTextWarning = layers.some(function (layer) {
                        return layer.textWarningLevel > 0;
                    });
                    if (anylayerTextWarning) {
                        return this.transfer(layerActions.resetLayers, document, layers, true);
                    } else {
                        return this.transfer(layerActions.resetBounds, document, layers);
                    }
                }
            });
    };
    setPostScript.reads = [locks.JS_DOC];
    setPostScript.writes = [locks.PS_DOC, locks.JS_UI];
    setPostScript.transfers = [updatePostScript, layerActions.resetBounds, layerActions.resetLayers];
    setPostScript.modal = true;

    /**
     * Update the type face (in terms of a type family and type style) of the given
     * layers in the given document. 
     *
     * @param {Document} document
     * @param {Immutable.Iterable.<Layers>} layers
     * @param {string} family The type face family name, e.g., "Helvetica Neue"
     * @param {string} style The type face style name, e.g., "Oblique"
     * @return {Promise}
     */
    var updateFace = function (document, layers, family, style) {
        var layerIDs = collection.pluck(layers, "id"),
            payload = {
                documentID: document.id,
                layerIDs: layerIDs,
                family: family,
                style: style
            };

        return this.dispatchAsync(events.document.TYPE_FACE_CHANGED, payload);
    };
    updateFace.reads = [];
    updateFace.writes = [locks.JS_DOC];
    updateFace.modal = true;

    /**
     * Set the type face (in terms of a type family and type style) of the given
     * layers in the given document. This triggers a layer bounds update.
     *
     * @param {Document} document
     * @param {Immutable.Iterable.<Layers>} layers
     * @param {string} family The type face family name, e.g., "Helvetica Neue"
     * @param {string} style The type face style name, e.g., "Oblique"
     * @return {Promise}
     */
    var setFace = function (document, layers, family, style) {
        var layerIDs = collection.pluck(layers, "id"),
            layerRefs = layerIDs.map(textLayerLib.referenceBy.id).toArray(),
            modal = this.flux.store("tool").getModalToolState();

        var setFacePlayObject = textLayerLib.setFace(layerRefs, family, style),
            typeOptions = _getTypeOptions(document.id, strings.ACTIONS.SET_TYPE_FACE, modal),
            setFacePromise = locking.playWithLockOverride(document, layers, setFacePlayObject, typeOptions),
            updatePromise = this.transfer(updateFace, document, layers, family, style);

        return Promise.join(updatePromise, setFacePromise)
            .bind(this)
            .then(function () {
                if (!modal) {
                    var anylayerTextWarning = layers.some(function (layer) {
                        return layer.textWarningLevel > 0;
                    });
                    if (anylayerTextWarning) {
                        return this.transfer(layerActions.resetLayers, document, layers, true);
                    } else {
                        return this.transfer(layerActions.resetBounds, document, layers);
                    }
                }
            });
    };
    setFace.reads = [locks.JS_DOC];
    setFace.writes = [locks.JS_UI, locks.PS_DOC];
    setFace.transfers = [updateFace, layerActions.resetBounds, layerActions.resetLayers];
    setFace.modal = true;

    /**
     * Update the type of the given layers in the given document. The alpha value of
     * the color is used to adjust the opacity of the given layers.
     *
     * @param {Document} document
     * @param {Immutable.Iterable.<Layers>} layers
     * @param {Color} color
     * @param {boolean} modal is the app in a modal state, which effects history
     * @param {object} options
     * @param {boolean=} options.coalesce Whether to coalesce this operation's history state
     * @param {boolean=} options.ignoreAlpha
     * @return {Promise}
     */
    var updateColor = function (document, layers, color, modal, options) {
        var layerIDs = collection.pluck(layers, "id"),
            normalizedColor = null;

        if (color !== null) {
            normalizedColor = color.normalizeAlpha();
        }

        var payload = {
            documentID: document.id,
            layerIDs: layerIDs,
            color: normalizedColor,
            coalesce: options.coalesce,
            ignoreAlpha: options.ignoreAlpha
        };

        if (!modal) {
            return this.dispatchAsync(events.document.history.optimistic.TYPE_COLOR_CHANGED, payload);
        } else {
            return this.dispatchAsync(events.document.TYPE_COLOR_CHANGED, payload);
        }
    };
    updateColor.reads = [];
    updateColor.writes = [locks.JS_DOC];
    updateColor.modal = true;

    /**
     * Set the type of the given layers in the given document. The alpha value of
     * the color is used to adjust the opacity of the given layers.
     *
     * @param {Document} document
     * @param {Immutable.Iterable.<Layers>} layers
     * @param {Color} color
     * @param {object} options
     * @param {boolean=} options.coalesce Whether to coalesce this operation's history state
     * @param {boolean=} options.ignoreAlpha Whether to ignore the alpha value of the
     *  given color and only update the opaque color value.
     * @return {Promise}
     */
    var setColor = function (document, layers, color, options) {
        var layerIDs = collection.pluck(layers, "id"),
            layerRefs = layerIDs.map(textLayerLib.referenceBy.id).toArray(),
            normalizedColor = color.normalizeAlpha(),
            opaqueColor = normalizedColor.opaque(),
            playObject = textLayerLib.setColor(layerRefs, opaqueColor),
            modal = this.flux.store("tool").getModalToolState(),
            typeOptions = _getTypeOptions(document.id, strings.ACTIONS.SET_TYPE_COLOR,
                modal, options.coalesce, options);

        if (!options.ignoreAlpha) {
            var opacity = Math.round(normalizedColor.opacity),
                setOpacityPlayObjects = layers.map(function (layer) {
                    var layerRef = [
                        documentLib.referenceBy.id(document.id),
                        layerLib.referenceBy.id(layer.id)
                    ];

                    return layerLib.setOpacity(layerRef, opacity);
                }).toArray();

            playObject = [playObject].concat(setOpacityPlayObjects);
        }
        
        var updatePromise = this.transfer(updateColor, document, layers, color, modal, options),
            setColorPromise = layerActionsUtil.playSimpleLayerActions(document, layers, playObject, true, typeOptions);

        return Promise.join(updatePromise, setColorPromise)
            .bind(this)
            .then(function () {
                if (!modal) {
                    var anylayerTextWarning = layers.some(function (layer) {
                        return layer.textWarningLevel > 0;
                    });
                    if (anylayerTextWarning) {
                        return this.transfer(layerActions.resetLayers, document, layers, true);
                    }
                }
            });
    };
    setColor.reads = [locks.JS_DOC];
    setColor.writes = [locks.PS_DOC];
    setColor.transfers = [updateColor, layerActions.resetLayers];
    setColor.modal = true;

    /**
     * Update our type size to reflect the type size of the given layers in the given document.
     *
     * @param {Document} document
     * @param {Immutable.Iterable.<Layers>} layers
     * @param {number} size The type size in pixels, e.g., 72
     * @return {Promise}
     */
    var updateSize = function (document, layers, size) {
        var layerIDs = collection.pluck(layers, "id"),
            payload = {
                documentID: document.id,
                layerIDs: layerIDs,
                size: size
            };
    
        return this.dispatchAsync(events.document.TYPE_SIZE_CHANGED, payload);
    };

    updateSize.reads = [];
    updateSize.writes = [locks.JS_DOC];
    updateSize.modal = true;
    /**
     * Set the type size of the given layers in the given document. This triggers
     * a layer bounds update.
     *
     * @param {Document} document
     * @param {Immutable.Iterable.<Layers>} layers
     * @param {number} size The type size in pixels, e.g., 72
     * @return {Promise}
     */
    var setSize = function (document, layers, size) {
        var layerIDs = collection.pluck(layers, "id"),
            layerRefs = layerIDs.map(textLayerLib.referenceBy.id).toArray(),
            modal = this.flux.store("tool").getModalToolState();

        // Ensure that size does not exceed PS font size bounds
        size = math.clamp(size, PS_MIN_FONT_SIZE, PS_MAX_FONT_SIZE);

        var setSizePlayObject = textLayerLib.setSize(layerRefs, size, "px"),
            typeOptions = _getTypeOptions(document.id, strings.ACTIONS.SET_TYPE_SIZE, modal),
            setSizePromise = locking.playWithLockOverride(document, layers, setSizePlayObject, typeOptions),
            updatePromise = this.transfer(updateSize, document, layers, size);

        return Promise.join(updatePromise, setSizePromise)
            .bind(this)
            .then(function () {
                if (!modal) {
                    var anylayerTextWarning = layers.some(function (layer) {
                        return layer.textWarningLevel > 0;
                    });
                    if (anylayerTextWarning) {
                        return this.transfer(layerActions.resetLayers, document, layers, true);
                    } else {
                        return this.transfer(layerActions.resetBounds, document, layers);
                    }
                }
            });
    };
    setSize.reads = [locks.JS_DOC];
    setSize.writes = [locks.JS_UI, locks.PS_DOC];
    setSize.transfers = [updateSize, layerActions.resetBounds, layerActions.resetLayers];
    setSize.modal = true;
    
    /**
     * Update the tracking value (aka letter-spacing) of the given layers in the given document.
     *
     * @param {Document} document
     * @param {Immutable.Iterable.<Layers>} layers
     * @param {number} tracking The tracking value
     * @return {Promise}
     */
    var updateTracking = function (document, layers, tracking) {
        var layerIDs = collection.pluck(layers, "id"),
            payload = {
                documentID: document.id,
                layerIDs: layerIDs,
                tracking: tracking
            };

        return this.dispatchAsync(events.document.TYPE_TRACKING_CHANGED, payload);
    };

    updateTracking.reads = [];
    updateTracking.writes = [locks.JS_DOC];
    updateTracking.modal = true;
    /**
     * Set the tracking value (aka letter-spacing) of the given layers in the given document.
     * This triggers a layer bounds update.
     *
     * @param {Document} document
     * @param {Immutable.Iterable.<Layers>} layers
     * @param {number} tracking The tracking value
     * @return {Promise}
     */
    var setTracking = function (document, layers, tracking) {
        var layerIDs = collection.pluck(layers, "id"),
            layerRefs = layerIDs.map(textLayerLib.referenceBy.id).toArray(),
            modal = this.flux.store("tool").getModalToolState(),
            psTracking = tracking / 1000; // PS expects tracking values that are 1/1000 what is shown in the UI

        var setTrackingPlayObject = textLayerLib.setTracking(layerRefs, psTracking),
            typeOptions = _getTypeOptions(document.id, strings.ACTIONS.SET_TYPE_TRACKING, modal),
            setTrackingPromise = locking.playWithLockOverride(document, layers, setTrackingPlayObject, typeOptions),
            updatePromise = this.transfer(updateTracking, document, layers, tracking);

        return Promise.join(updatePromise, setTrackingPromise)
            .bind(this)
            .then(function () {
                if (!modal) {
                    var anylayerTextWarning = layers.some(function (layer) {
                        return layer.textWarningLevel > 0;
                    });
                    if (anylayerTextWarning) {
                        return this.transfer(layerActions.resetLayers, document, layers, true);
                    } else {
                        return this.transfer(layerActions.resetBounds, document, layers);
                    }
                }
            });
    };
    setTracking.reads = [locks.JS_DOC];
    setTracking.writes = [locks.PS_DOC, locks.JS_UI];
    setTracking.transfers = [updateTracking, layerActions.resetBounds, layerActions.resetLayers];
    setTracking.modal = true;

    /**
     * Update the leading value (aka line-spacing) of the given layers in the given document.
     *
     * @param {Document} document
     * @param {Immutable.Iterable.<Layers>} layers
     * @param {number} leading The leading value in pixels, or if null then auto.
     * @return {Promise}
     */
    var updateLeading = function (document, layers, leading) {
        var layerIDs = collection.pluck(layers, "id"),
            payload = {
                documentID: document.id,
                layerIDs: layerIDs,
                leading: leading
            };

        return this.dispatchAsync(events.document.TYPE_LEADING_CHANGED, payload);
    };
    updateLeading.reads = [];
    updateLeading.writes = [locks.JS_DOC];
    updateLeading.modal = true;

    /**
     * Set the leading value (aka line-spacing) of the given layers in the given document.
     * This triggers a layer bounds update.
     *
     * @param {Document} document
     * @param {Immutable.Iterable.<Layers>} layers
     * @param {number} leading The leading value in pixels, or if null then auto.
     * @return {Promise}
     */
    var setLeading = function (document, layers, leading) {
        var layerIDs = collection.pluck(layers, "id"),
            layerRefs = layerIDs.map(textLayerLib.referenceBy.id).toArray(),
            modal = this.flux.store("tool").getModalToolState(),
            autoLeading = leading === -1;

        if (!autoLeading && leading < 0.1) {
            leading = 0.1;
        }

        var setLeadingPlayObject = textLayerLib.setLeading(layerRefs, autoLeading, leading, "px"),
            typeOptions = _getTypeOptions(document.id, strings.ACTIONS.SET_TYPE_LEADING, modal),
            setLeadingPromise = locking.playWithLockOverride(document, layers, setLeadingPlayObject, typeOptions),
            updatePromise = this.transfer(updateLeading, document, layers, leading);

        return Promise.join(updatePromise, setLeadingPromise).bind(this).then(function () {
            if (!modal) {
                var anylayerTextWarning = layers.some(function (layer) {
                    return layer.textWarningLevel > 0;
                });
                if (anylayerTextWarning) {
                    return this.transfer(layerActions.resetLayers, document, layers, true);
                } else {
                    return this.transfer(layerActions.resetBounds, document, layers);
                }
            }
        });
    };
    setLeading.reads = [locks.JS_DOC];
    setLeading.writes = [locks.PS_DOC, locks.JS_UI];
    setLeading.transfers = [updateLeading, layerActions.resetBounds, layerActions.resetLayers];
    setLeading.modal = true;

    /**
     * Update the paragraph alignment of the given layers in the given document.
     *
     * @param {Document} document
     * @param {Immutable.Iterable.<Layers>} layers
     * @param {string} alignment The alignment kind
     * @return {Promise}
     */
    var updateAlignment = function (document, layers, alignment) {
        var layerIDs = collection.pluck(layers, "id"),
            payload = {
                documentID: document.id,
                layerIDs: layerIDs,
                alignment: alignment
            };

        return this.dispatchAsync(events.document.TYPE_ALIGNMENT_CHANGED, payload);
    };
    updateAlignment.reads = [];
    updateAlignment.writes = [locks.JS_DOC];
    updateAlignment.modal = true;

    /**
     * Set the paragraph alignment of the given layers in the given document.
     * This triggers a layer bounds update.
     *
     * @param {Document} document
     * @param {Immutable.Iterable.<Layers>} layers
     * @param {string} alignment The alignment kind
     * @param {object} options Batch play options
     * @return {Promise}
     */
    var setAlignment = function (document, layers, alignment, options) {
        var layerIDs = collection.pluck(layers, "id"),
            layerRefs = layerIDs.map(textLayerLib.referenceBy.id).toArray(),
            modal = this.flux.store("tool").getModalToolState();

        var setAlignmentPlayObject = textLayerLib.setAlignment(layerRefs, alignment),
            typeOptions = _getTypeOptions(document.id, strings.ACTIONS.SET_TYPE_ALIGNMENT,
                modal, false, options),
            setAlignmentPromise = locking.playWithLockOverride(document, layers, setAlignmentPlayObject, typeOptions),
            transferPromise = this.transfer(updateAlignment, document, layers, alignment);

        return Promise.join(transferPromise, setAlignmentPromise).bind(this).then(function () {
            if (!modal) {
                var anylayerTextWarning = layers.some(function (layer) {
                    return layer.textWarningLevel > 0;
                });
                if (anylayerTextWarning) {
                    return this.transfer(layerActions.resetLayers, document, layers, true);
                } else {
                    return this.transfer(layerActions.resetBounds, document, layers);
                }
            }
        });
    };
    setAlignment.reads = [locks.JS_DOC];
    setAlignment.writes = [locks.PS_DOC, locks.JS_UI];
    setAlignment.transfers = [updateAlignment, layerActions.resetBounds, layerActions.resetLayers];
    setAlignment.modal = true;

    /**
     * Update the given layer models with all the provided text properties.
     * TODO: Ideally, this would subsume all the other type update actions.
     * Note: this is action does NOT update history
     *
     * @param {Document} document
     * @param {Immutable.Iterable.<Layer>} layers
     * @param {object} properties May contain properties found in CharacterStyle and ParagraphStyle models
     * @return {Promise}
     */
    var updateProperties = function (document, layers, properties) {
        var payload = {
            documentID: document.id,
            layerIDs: collection.pluck(layers, "id"),
            properties: properties
        };

        // The selection change may not yet have completed before the first
        // updateTextProperties event arrives. Hence, we ensure that the text
        // layer is initialized before proceeding.
        return this.transfer(layerActions.initializeLayers, document, layers)
            .bind(this)
            .then(function () {
                this.dispatch(events.document.TYPE_PROPERTIES_CHANGED, payload);
            });
    };
    updateProperties.reads = [];
    updateProperties.writes = [locks.JS_DOC];
    updateProperties.transfers = [layerActions.initializeLayers];
    updateProperties.modal = true;

    /**
     * Duplicates the layer effects of the source layer on all the target layers
     *
     * @param {Document} document
     * @param {Immutable.Iterable.<Layer>} targetLayers
     * @param {Layer} source
     * @return {Promise}
     */
    var duplicateTextStyle = function (document, targetLayers, source) {
        var layerIDs = collection.pluck(targetLayers, "id"),
            layerRefs = layerIDs.map(textLayerLib.referenceBy.id).toArray(),
            fontStore = this.flux.store("font"),
            typeObject = fontStore.getTypeObjectFromLayer(source),
            applyObj = textLayerLib.applyTextStyle(layerRefs, typeObject);

        return descriptor.playObject(applyObj)
            .bind(this)
            .then(function () {
                return this.transfer(layerActions.resetLayers, document, targetLayers);
            });
    };
    duplicateTextStyle.reads = [locks.JS_TYPE, locks.JS_DOC];
    duplicateTextStyle.writes = [locks.PS_DOC];
    duplicateTextStyle.transfers = [layerActions.resetLayers];
  
    /**
     * Applies the given text style to target layers
     *
     * @param {Document} document
     * @param {?Immutable.Iterable.<Layer>} targetLayers Default is selected layers
     * @param {object} style Style object
     * @param {object} options Batch play options
     * @return {Promise}
     */
    var applyTextStyle = function (document, targetLayers, style, options) {
        targetLayers = targetLayers || document.layers.selected;

        var layerIDs = collection.pluck(targetLayers, "id"),
            layerRefs = layerIDs.map(textLayerLib.referenceBy.id).toArray(),
            applyObj = textLayerLib.applyTextStyle(layerRefs, style),
            modal = this.flux.store("tool").getModalToolState(),
            typeOptions = _getTypeOptions(document.id, strings.ACTIONS.APPLY_TEXT_STYLE,
                modal, options && options.coalesce, options);

        if (style.textAlignment) {
            var alignObj = textLayerLib.setAlignment(layerRefs, style.textAlignment);

            applyObj = [applyObj, alignObj];
        }
        this.dispatchAsync(events.style.HIDE_HUD);
        
        return layerActionsUtil.playSimpleLayerActions(document, targetLayers, applyObj, true, typeOptions)
            .bind(this)
            .then(function () {
                return this.transfer(layerActions.resetLayers, document, targetLayers);
            });
    };
    applyTextStyle.reads = [locks.JS_DOC];
    applyTextStyle.writes = [locks.PS_DOC];
    applyTextStyle.transfers = [layerActions.resetLayers];

    /**
     * Initialize the list of installed fonts from Photoshop.
     *
     * @private
     * @param {boolean=} force If true, re-initialize if necessary.
     * @return {Promise}
     */
    var initFontList = function (force) {
        var fontStore = this.flux.store("font"),
            fontState = fontStore.getState(),
            initialized = fontState.initialized;

        if (initialized && !force) {
            return Promise.resolve();
        }

        // Determine whether to use native or English-only font names
        var englishFontNamesPromise;
        if (fontState.initialized) {
            englishFontNamesPromise = Promise.resolve(fontState.englishFontNames);
        } else {
            englishFontNamesPromise = descriptor.getProperty("application", "typePreferences")
                .get("showEnglishFontNames");
        }

        return englishFontNamesPromise
            .bind(this)
            .then(function (englishFontNames) {
                var fontListPlayObject = appLib.getFontList(englishFontNames);

                return descriptor.playObject(fontListPlayObject)
                    .get("fontList")
                    .bind(this)
                    .then(function (payload) {
                        payload.englishFontNames = englishFontNames;

                        this.dispatch(events.font.INIT_FONTS, payload);
                    });
            })
            .then(function () {
                var resetPromises = this.flux.store("application")
                    .getOpenDocuments()
                    .filter(function (document) {
                        // Skip uninitialized documents
                        return document.layers;
                    })
                    .map(function (document) {
                        var layers = document.layers.all,
                            typeLayers = layers.filter(function (layer) {
                                return layer.isTextLayer();
                            });

                        // Fully update selected layers; only update non-lazy properties for unselected layers.
                        return this.transfer(layerActions.resetLayers, document, typeLayers, true, true);
                    }, this)
                    .toArray();

                return Promise.all(resetPromises);
            });
    };
    initFontList.reads = [locks.PS_APP];
    initFontList.writes = [locks.JS_TYPE];
    initFontList.transfers = [layerActions.resetLayers];
    initFontList.modal = true;

    /**
     * If the font list has already been initialized, re-initialize it in
     * order to pick up added or removed fonts.
     *
     * @private
     */
    var _fontListChangedHandler;

    /**
     * Listen for font-list changes.
     *
     * @return {Promise}
     */
    var beforeStartup = function () {
        _fontListChangedHandler = synchronization.debounce(function () {
            var fontStore = this.flux.store("font"),
                fontState = fontStore.getState(),
                initialized = fontState.initialized;

            if (initialized) {
                return this.flux.actions.type.initFontList(true);
            } else {
                return Promise.resolve();
            }
        }, this, 500);

        descriptor.addListener("fontListChanged", _fontListChangedHandler);

        return Promise.resolve();
    };
    beforeStartup.reads = [];
    beforeStartup.writes = [];
    beforeStartup.modal = [];

    /**
     * Remove font-list change listener.
     *
     * @return {Promise}
     */
    var onReset = function () {
        descriptor.removeListener("fontListChanged", _fontListChangedHandler);
        _fontListChangedHandler = null;

        return Promise.resolve();
    };
    onReset.reads = [];
    onReset.writes = [];
    onReset.modal = [];

    exports.setPostScript = setPostScript;
    exports.updatePostScript = updatePostScript;
    exports.setFace = setFace;
    exports.updateFace = updateFace;
    exports.setColor = setColor;
    exports.updateColor = updateColor;
    exports.setSize = setSize;
    exports.updateSize = updateSize;
    exports.setTracking = setTracking;
    exports.updateTracking = updateTracking;
    exports.setLeading = setLeading;
    exports.updateLeading = updateLeading;
    exports.setAlignment = setAlignment;
    exports.initFontList = initFontList;
    exports.updateAlignment = updateAlignment;
    exports.updateProperties = updateProperties;

    exports.duplicateTextStyle = duplicateTextStyle;
    exports.applyTextStyle = applyTextStyle;

    exports.beforeStartup = beforeStartup;
    exports.onReset = onReset;
});
