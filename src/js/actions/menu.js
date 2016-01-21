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

    var adapter = require("adapter"),
        ps = require("adapter").ps,
        ui = require("adapter").ps.ui,
        descriptor = require("adapter").ps.descriptor;

    var events = require("js/events"),
        locks = require("js/locks"),
        system = require("js/util/system"),
        objUtil = require("js/util/object"),
        log = require("js/util/log"),
        headlights = require("js/util/headlights"),
        policyActions = require("./policy"),
        preferencesActions = require("./preferences");

    var macMenuJSON = require("static/menu-mac.json"),
        winMenuJSON = require("static/menu-win.json"),
        rawShortcuts = require("js/util/shortcuts"),
        rawMenuActions = require("static/menu-actions.json"),
        rawTemplates = require("static/templates.json"),
        rawMenuObj = system.isMac ? macMenuJSON : winMenuJSON,
        rawMenuShortcuts = rawShortcuts.MENU;
        
    // On debug builds, we always enable cut/copy/paste so they work in dev tools
    if (__PG_DEBUG__) {
        rawMenuActions.EDIT.CUT["$enable-rule"] = "always";
        rawMenuActions.EDIT.COPY["$enable-rule"] = "always";
        rawMenuActions.EDIT.PASTE["$enable-rule"] = "always";
    }

    /**
     * List of place command menu IDs.
     *
     * @private
     * @type {number}
     */
    var _PLACE_LINKED_MENU_ID = 3090,
        _PLACE_EMBEDDED_MENU_ID = 1032;

    /**
     * Execute a native Photoshop menu command.
     * 
     * @param {{commandID: number, waitForCompletion: boolean=}} payload
     * @return {Promise}
     */
    var native = function (payload) {
        if (!payload.hasOwnProperty("commandID")) {
            var error = new Error("Missing native menu command ID");
            return Promise.reject(error);
        }

        var isPlaceCommand = payload.commandID === _PLACE_LINKED_MENU_ID ||
                payload.commandID === _PLACE_EMBEDDED_MENU_ID;
        
        return Promise.bind(this)
            .then(function () {
                // This is a hack for the place linked/embedded menu commands which do not
                // seem to promptly emit a toolModalStateChanged:enter event
                if (isPlaceCommand) {
                    this.dispatch(events.menus.PLACE_COMMAND, { executing: true });
                    
                    if (!this.flux.store("policy").areAllSuspended()) {
                        return this.transfer(policyActions.suspendAllPolicies);
                    }
                }
            })
            .then(function () {
                // Photoshop expects commandId with a lower case d, so convert here
                payload.commandId = payload.commandID;
                
                return ps.performMenuCommand(payload);
            })
            .then(function (success) {
                if (__PG_DEBUG__ && !success) {
                    log.error("Menu command not available: " + payload.commandID);
                }
                
                // Return the menu command result for outer promise chain.
                return success;
            })
            .catch(function (error) {
                if (isPlaceCommand) {
                    // Call the handler for any exceptions to make sure
                    // the policies are restored and relevent event is dispatched.
                    return this.transfer(handleExecutedPlaceCommand);
                }
                
                // Re-throw the error
                throw error;
            });
    };
    native.action = {
        reads: locks.ALL_NATIVE_LOCKS,
        writes: locks.ALL_NATIVE_LOCKS,
        transfers: [policyActions.suspendAllPolicies, "menu.handleExecutedPlaceCommand"]
    };

    /**
     * Execute a native Photoshop menu command modally.
     * 
     * @param {{commandID: number, waitForCompletion: boolean?}} payload
     * @return {Promise}
     */
    var nativeModal = function (payload) {
        return native.call(this, payload);
    };
    nativeModal.action = {
        reads: locks.ALL_NATIVE_LOCKS,
        writes: locks.ALL_NATIVE_LOCKS,
        modal: true
    };

    /**
     * Open a URL in the user's default browser.
     * 
     * @param {{url: string, category: string, subcategory: string, eventName: string}} payload
     * @return {Promise}
     */
    var openURL = function (payload) {
        if (!payload.hasOwnProperty("url")) {
            var error = new Error("Missing URL");
            return Promise.reject(error);
        }
        if (payload.category !== null && payload.subcategory !== null && payload.eventName !== null) {
            headlights.logEvent(payload.category, payload.subcategory, payload.eventName);
        }

        return adapter.openURLInDefaultBrowser(payload.url);
    };
    openURL.action = {
        reads: [],
        writes: [],
        modal: true
    };

    /**
     * Temporary helper function to easily open the testrunner. This should
     * eventually replaced with a action that opens the testrunner in a new
     * window.
     */
    var runTests = function () {
        if (__PG_DEBUG__) {
            var href = window.location.href,
                baseHref = href.substring(0, href.lastIndexOf("src/index.html")),
                testHref = baseHref + "test/index.html";

            window.setTimeout(function () {
                window.location.href = testHref;
            }, 0);
        }

        return Promise.resolve();
    };
    runTests.action = {
        reads: [],
        writes: []
    };

    /**
     * An action that always fails, for testing purposes.
     *
     * @private
     * @return {Promise}
     */
    var actionFailure = function () {
        return Promise.reject(new Error("Test: action failure"));
    };
    actionFailure.action = {
        reads: [],
        writes: []
    };

    /**
     * An action with a transfer that always fails, for testing purposes.
     *
     * @private
     * @return {Promise}
     */
    var transferFailure = function () {
        return this.transfer(actionFailure)
            .catch(function () {
                // Failed transfers always cause a controller reset, so
                // catching these failures doesn't really help.
            });
    };
    transferFailure.action = {
        reads: [],
        writes: [],
        transfers: [actionFailure]
    };

    /**
     * A flag for testing purposes which, if set, will cause onReset to fail.
     * 
     * @private
     * @type {boolean}
     */
    var _failOnReset = false;

    /**
     * An action that always fails, for testing purposes, and which causes onReset
     * to fail as well.
     *
     * @private
     * @return {Promise}
     */
    var resetFailure = function () {
        _failOnReset = true;
        return Promise.reject(new Error("Test: reset failure"));
    };
    resetFailure.action = {
        reads: [],
        writes: []
    };

    /**
     * An action that always fails, for testing purposes, and which causes onReset
     * to fail as well.
     *
     * @private
     * @return {Promise}
     */
    var corruptModel = function () {
        var applicationStore = this.flux.store("application"),
            documentStore = this.flux.store("document"),
            document = applicationStore.getCurrentDocument();

        if (document) {
            var index = document.layers.index,
                nextIndex = index.unshift(null),
                nextDocument = document.setIn(["layers", "index"], nextIndex);

            documentStore._openDocuments[document.id] = nextDocument;
        }

        return Promise.reject(new Error("Test: corrupt model"));
    };
    corruptModel.action = {
        reads: [],
        writes: []
    };

    /**
     * Run layer panel performance tests.   
     *
     * @private
     * @return {Promise}
     */
    var layerPanelPerformanceTest = function () {
        var flux = this.flux,
            applicationStore = flux.store("application"),
            document = applicationStore.getCurrentDocument(),
            openDocuments = applicationStore.getOpenDocuments();

        if (openDocuments.size !== 1 || !document.name.match(/vermilion/i)) {
            window.alert(
                "To run the performance test, the current document must be " +
                "the Vermilion file, and there should be only one open document");
            return Promise.resolve();
        }

        var continueTest = window.confirm("Please start the Timeline recording, and then hit OK to begin the test.");

        if (!continueTest) {
            return Promise.resolve();
        }

        // Mute the other time stamps to make the timeline cleaner.
        var timeStamp = log.timeStamp;
        log.timeStamp = _.noop;

        var layerFaceElements,
            artboardElement,
            artboardIconElement,
            artboardVisibilityElement,
            delayBetweenTest = 1500,
            artboards = document.layers.roots.map(function (root) {
                return document.layers.byID(root.id);
            });

        return flux.actions.groups.setGroupExpansion(document, artboards, true, true)
            .then(function () {
                flux.actions.layers.deselectAll(document);
            })
            .then(function () {
                layerFaceElements = window.document.querySelectorAll(".face__depth-6");
                artboardElement = window.document.querySelector(".face__depth-0");
                artboardIconElement = window.document.querySelector(".face__depth-0 .face__kind");
                artboardVisibilityElement = window.document.querySelector(".face__depth-0 .face__button_visibility");
                layerFaceElements[0].scrollIntoViewIfNeeded();
            })
            // Test Layer Selection
            .delay(delayBetweenTest)
            .then(function () {
                timeStamp("Layer selection 1");
                layerFaceElements[0].click();
            })
            .delay(delayBetweenTest)
            .then(function () {
                timeStamp("Layer selection 2");
                layerFaceElements[1].click();
            })
            .delay(delayBetweenTest)
            .then(function () {
                timeStamp("Layer selection 3");
                layerFaceElements[2].click();
            })
            .delay(delayBetweenTest)
            .then(function () {
                timeStamp("Layer selection 4");
                layerFaceElements[3].click();
            })
            .delay(delayBetweenTest)
            // Test Art board Selection
            .then(function () {
                artboardElement.scrollIntoViewIfNeeded();
            })
            .delay(delayBetweenTest)
            .then(function () {
                timeStamp("Art board selection 1");
                artboardElement.click();
            })
            .delay(delayBetweenTest)
            .then(function () {
                timeStamp("Art board deselection 1");
                layerFaceElements[0].click();
            })
            .delay(delayBetweenTest)
            .then(function () {
                timeStamp("Art board selection 2");
                artboardElement.click();
            })
            .delay(delayBetweenTest)
            .then(function () {
                timeStamp("Art board deselection 2");
                layerFaceElements[0].click();
            })
            .delay(delayBetweenTest)
            // Test Art board expand/collapse
            .then(function () {
                timeStamp("Art board collapse 1");
                artboardIconElement.click();
            })
            .delay(delayBetweenTest)
            .then(function () {
                timeStamp("Art board expand 1");
                artboardIconElement.click();
            })
            .delay(delayBetweenTest)
            .then(function () {
                timeStamp("Art board collapse 2");
                artboardIconElement.click();
            })
            .delay(delayBetweenTest)
            .then(function () {
                timeStamp("Art board expand 2");
                artboardIconElement.click();
            })
            .delay(delayBetweenTest)
            // Test Art board visibility
            .then(function () {
                timeStamp("Art board not-visible 1");
                artboardVisibilityElement.click();
            })
            .delay(delayBetweenTest)
            .then(function () {
                timeStamp("Art board visible 1");
                artboardVisibilityElement.click();
            })
            .delay(delayBetweenTest)
            .then(function () {
                timeStamp("Art board not-visible 2");
                artboardVisibilityElement.click();
            })
            .delay(delayBetweenTest)
            .then(function () {
                timeStamp("Art board visible 2");
                artboardVisibilityElement.click();
            })
            .delay(delayBetweenTest)
            // Done
            .finally(function () {
                timeStamp("End of test");
                log.timeStamp = timeStamp;
                window.alert("Please stop recording and check for the result");
            });
    };
    layerPanelPerformanceTest.action = {
        reads: [],
        writes: []
    };

    /**
     * Resolve an action path into a callable action function
     *
     * @private
     * @param {string} actionPath
     * @return {function()}
     */
    var _resolveAction = function (actionPath) {
        var actionNameParts = actionPath.split("."),
            actionModuleName = actionNameParts[0],
            actionName = actionNameParts[1],
            actionNameThrottled = actionName + "Throttled",
            actionThrottled = objUtil.getPath(this.flux.actions, actionModuleName)[actionNameThrottled];

        return actionThrottled;
    };

    /**
     * Call action for menu command
     *
     * @param {string} commandID 
     */
    var _playMenuCommand = function (commandID) {
        var menuStore = this.flux.store("menu"),
            descriptor = menuStore.getApplicationMenu().getMenuAction(commandID);

        if (!descriptor) {
            log.error("Unknown menu command:", commandID);
            return;
        }

        descriptor = descriptor.toObject();

        var action = _resolveAction.call(this, descriptor.$action),
            $payload = descriptor.$payload,
            $dontLog = descriptor.$dontLog || false,
            menuKeys = commandID.split("."),
            subcategory = menuKeys.shift(),
            event = menuKeys.pop();

        if (!$payload || !$payload.preserveFocus) {
            window.document.activeElement.blur();
        }

        if (!$dontLog) {
            headlights.logEvent("menu", subcategory, _.kebabCase(event));
        }

        action($payload);
    };

    /**
     * Reload the page.
     *
     * @private
     * @return {Promise}
     */
    var resetRecess = function () {
        window.location.reload();
        return Promise.resolve();
    };
    resetRecess.action = {
        reads: [],
        writes: []
    };

    /**
     * Debug only method to toggle pointer policy area visualization
     *
     * @return {Promise}
     */
    var togglePolicyFrames = function () {
        if (!__PG_DEBUG__) {
            return Promise.resolve();
        }

        var preferencesStore = this.flux.store("preferences"),
            preferences = preferencesStore.getState(),
            enabled = preferences.get("policyFramesEnabled");

        return this.transfer(preferencesActions.setPreference, "policyFramesEnabled", !enabled);
    };
    togglePolicyFrames.action = {
        reads: [],
        writes: [locks.JS_PREF],
        transfers: [preferencesActions.setPreference]
    };

    /**
     * Debug only method to toggle post condition verification
     *
     * @return {Promise}
     */
    var togglePostconditions = function () {
        if (!__PG_DEBUG__) {
            return Promise.resolve();
        }

        var preferencesStore = this.flux.store("preferences"),
            preferences = preferencesStore.getState(),
            enabled = preferences.get("postConditionsEnabled");

        return this.transfer(preferencesActions.setPreference, "postConditionsEnabled", !enabled);
    };
    togglePostconditions.action = {
        reads: [],
        writes: [locks.JS_PREF],
        transfers: [preferencesActions.setPreference]
    };
    
    /**
     * This handler will be triggered when the user confirm or cancel the new layer 
     * created from the place-linked or place-embedded menu item.
     *
     * @return {Promise}
     */
    var handleExecutedPlaceCommand = function () {
        return this.dispatchAsync(events.menus.PLACE_COMMAND, { executing: false })
            .bind(this)
            .then(function () {
                if (this.flux.store("policy").areAllSuspended()) {
                    return this.transfer(policyActions.restoreAllPolicies);
                }
            });
    };
    handleExecutedPlaceCommand.action = {
        reads: [],
        writes: [locks.JS_MENU, locks.PS_MENU],
        transfers: [policyActions.restoreAllPolicies]
    };

    /**
     * Debug-only method to toggle action transfer logging
     *
     * @return {Promise}
     */
    var toggleActionTransferLogging = function () {
        if (!__PG_DEBUG__) {
            return Promise.resolve();
        }

        var preferencesStore = this.flux.store("preferences"),
            preferences = preferencesStore.getState(),
            enabled = preferences.get("logActionTransfers");

        return this.transfer(preferencesActions.setPreference, "logActionTransfers", !enabled);
    };
    toggleActionTransferLogging.action = {
        reads: [],
        writes: [locks.JS_PREF],
        transfers: [preferencesActions.setPreference]
    };

    /**
     * Event handlers initialized in beforeStartup.
     *
     * @private
     * @type {function()}
     */
    var _menuChangeHandler,
        _adapterMenuHandler,
        _toolModalStateChangedHandler;

    /**
     * Loads menu descriptors, installs menu handlers and a menu store listener
     * to reload menus
     * 
     * @return {Promise}
     */
    var beforeStartup = function () {
        // We listen to menu store directly from this action
        // and reload menus, menu store emits change events
        // only when the menus actually have changed
        _menuChangeHandler = function () {
            var menuStore = this.flux.store("menu"),
                appMenu = menuStore.getApplicationMenu();

            if (appMenu !== null) {
                var menuDescriptor = appMenu.getMenuDescriptor();
                ui.installMenu(menuDescriptor)
                    .catch(function (err) {
                        log.warn("Failed to install menu: ", err, menuDescriptor);
                    });
            }
        }.bind(this);

        this.flux.store("menu").on("change", _menuChangeHandler);
        
        if (!__PG_DEBUG__) {
            var debugMenuIndex = rawMenuObj.menu.findIndex(function (menu) {
                return menu.id === "DEBUG";
            });

            rawMenuObj.menu.splice(debugMenuIndex, 1);
        }

        // Menu store waits for this event to parse descriptors
        this.dispatch(events.menus.INIT_MENUS, {
            menus: rawMenuObj,
            shortcuts: rawMenuShortcuts,
            templates: rawTemplates,
            actions: rawMenuActions
        });

        // Menu item clicks come to us from Photoshop through this event
        var controller = this.controller;
        _adapterMenuHandler = function (payload) {
            if (!controller.active) {
                return;
            }
            
            _playMenuCommand.call(this, payload.command);
        }.bind(this);
        ui.on("menu", _adapterMenuHandler);
        
        _toolModalStateChangedHandler = function (event) {
            var isExecutingPlaceCommand = this.flux.store("menu").getState().isExecutingPlaceCommand,
                modalStateEnded = event.state && event.state._value === "exit";

            if (isExecutingPlaceCommand && modalStateEnded) {
                this.flux.actions.menu.handleExecutedPlaceCommand();
            }
        }.bind(this);
        descriptor.addListener("toolModalStateChanged", _toolModalStateChangedHandler);

        return Promise.resolve();
    };
    beforeStartup.action = {
        reads: [],
        writes: [locks.JS_MENU, locks.PS_MENU]
    };
    
    /**
     * Send info about menu commands to search store
     *
     * @return {Promise}
     */
    var afterStartup = function () {
        return this.transfer("search.commands.registerMenuCommandSearch");
    };
    afterStartup.action = {
        reads: [],
        writes: [],
        transfers: ["search.commands.registerMenuCommandSearch"]
    };

    /**
     * Remove event handlers.
     *
     * @private
     * @return {Promise}
     */
    var onReset = function () {
        ui.removeListener("menu", _adapterMenuHandler);
        this.flux.store("menu").removeListener("change", _menuChangeHandler);
        descriptor.removeListener("toolModalStateChanged", _toolModalStateChangedHandler);

        // For debugging purposes only
        if (_failOnReset) {
            return Promise.reject();
        }

        return Promise.resolve();
    };
    onReset.action = {
        reads: [],
        writes: []
    };

    exports.native = native;
    exports.nativeModal = nativeModal;
    exports.openURL = openURL;
    exports.runTests = runTests;
    exports.actionFailure = actionFailure;
    exports.transferFailure = transferFailure;
    exports.resetFailure = resetFailure;
    exports.corruptModel = corruptModel;
    exports.layerPanelPerformanceTest = layerPanelPerformanceTest;
    exports.resetRecess = resetRecess;
    exports.handleExecutedPlaceCommand = handleExecutedPlaceCommand;
    exports._playMenuCommand = _playMenuCommand;

    exports.togglePolicyFrames = togglePolicyFrames;
    exports.togglePostconditions = togglePostconditions;
    exports.toggleActionTransferLogging = toggleActionTransferLogging;

    exports.beforeStartup = beforeStartup;
    exports.afterStartup = afterStartup;
    exports.onReset = onReset;
});
