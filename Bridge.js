// ==UserScript==
// @name         Character Engine — Bridge v3.0.37 (Commentator avatar reply)
// @namespace    Violentmonkey Scripts
// @version      3.0.37
// @description  CE bridge: image generation, storage, painters, generation indicator
// @match        https://novelai.net/*
// @license      MIT
// @run-at       document-start
// @inject-into  page
// @sandbox      raw
// @grant        none
// @downloadURL https://update.greasyfork.org/scripts/587717/Character%20Engine%20%E2%80%94%20Bridge%20v3036.user.js
// @updateURL https://update.greasyfork.org/scripts/587717/Character%20Engine%20%E2%80%94%20Bridge%20v3036.meta.js
// ==/UserScript==

// CE-INDEX (bridge). Shared by Character Engine (CE) and CharacterRoom (CR). [CR-*] tags mark
// CR additions; a CR change must leave CE working.
//
// PARTS: 0.6 icons; 0 worker transport (document-start); 1 bridge body (DOMContentLoaded):
// 1 config, 5 state, 6 engine messaging, 7 image generation, 7b generation pill, 8 image IndexedDB,
// 8b portrait IndexedDB, 13c native hooks and painters, 13d-2 chat avatar painter, 13e surface image
// painter, 17 utilities.
//
// TRANSPORT: PART 0 wraps worker.postMessage to install window.NAITMBridge; that wrap is the
// channel. Envelope {type, sid, payload} on "hypebot".
//   bridge -> engine: HANDSHAKE_ACK {engine, crAware, ccavClear} AE_CARD_IMPORT_RESULT AE_CHARCHAT_ACTION
//     AE_CHAR_IMAGE_SLOTS AE_CHAR_IMAGE_UPLOADED AE_GALLERY_INDEX_RESP AE_IMG_EDIT_OPEN
//     AE_IMG_META_RESP AE_IMG_REGEN_DONE AE_SET_PLAYER_FLAVOR AE_STORY_IMG_DROP AE_VIEWPORT
//   engine -> bridge (one switch): HANDSHAKE_REQUEST GENERATE_IMAGE STORY_ID_SYNC
//     CLICK_GENERATE_NOW AE_ENGINE_THINKING AE_CHAT_BUBBLE_STYLE AE_DELETE_PORTRAIT_CASCADE
//     AE_CHAR_IMAGE_ACTION AE_GALLERY_INDEX_REQ AE_IMG_META_REQ AE_IMG_REGEN AE_GALLERY_ACTION
//     AE_CARD_IMPORT
// A new verb is an `op` on an existing message before it is a new name. Unknown names are logged.
// Nothing is ever appended inside .ProseMirror; painters decorate editor widgets only.

// PART 0.6 — ICON REGISTRY

var CyberIcons = {
    bolt: '<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>',
    regen: '<path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" stroke-linecap="round" stroke-linejoin="round"/>',
    pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" stroke-linecap="round" stroke-linejoin="round"/>',
    trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6" stroke-linecap="round" stroke-linejoin="round"/>'
};

// PART 0 — NAI TM BRIDGE INSTALLER  (runs at document-start)

(function installNAITMBridge() {
    'use strict';
    var INSTALL_KEY = '__nai_tm_bridge_v1__';
    if (window[INSTALL_KEY]) { console.log('[NAI TM Bridge] Already installed.'); return; }

    var DEBUG = false;
    var TM_SID = 'tampermonkey';
    var TYPE_HANDSHAKE = 'HANDSHAKE', TYPE_MESSAGE = 'MESSAGE';
    var HANDSHAKE_IN = 'NAI_SCRIPT:IN', HANDSHAKE_OUT = 'NAI_SCRIPT:OUT';
    var API_CALL = 'apiCall', INVOKE_CALLBACK = 'invokeCallback';
    var METHOD_ON_MSG = 'messaging.onMessage', METHOD_BROADCAST = 'messaging.broadcast';

    var seq = 0, workerSeq = 0;
    var inboundScripts = new Map(), outboundScripts = new Map();
    var listeners = new Map(), workerState = new WeakMap(), knownWorkers = new Set();

    function log()  { if (DEBUG) console.log.apply(console, ['[NAI TM Bridge]'].concat(Array.prototype.slice.call(arguments))); }
    function warn() { console.warn.apply(console, ['[NAI TM Bridge]'].concat(Array.prototype.slice.call(arguments))); }
    function isObj(v) { return v !== null && typeof v === 'object'; }
    function nextId(p) { return p + '_' + (++seq); }

    function getWorkerState(w) {
        var s = workerState.get(w);
        if (!s) { s = { id: ++workerSeq, callbacks: new Map() }; workerState.set(w, s); knownWorkers.add(w); }
        return s;
    }
    function rememberScript(map, sid, worker, dir) {
        var ex = map.get(sid);
        if (ex && ex.worker !== worker) warn('Script "' + sid + '" moved worker.');
        map.set(sid, { sid: sid, worker: worker, direction: dir, seenAt: Date.now() });
        log('Registered ' + dir + ' script:', sid);
    }
    function registerCallback(worker, cbName, filter) {
        getWorkerState(worker).callbacks.set(cbName, { callbackName: cbName, filter: isObj(filter) ? filter : null });
        log('Worker #' + getWorkerState(worker).id + ' registered callback:', cbName);
    }
    function cbMatchesFilter(meta, opts) {
        var f = meta.filter; if (!isObj(f)) return true;
        if ('channel' in f && f.channel != null && f.channel !== opts.channel) return false;
        if ('fromScriptId' in f && f.fromScriptId != null && f.fromScriptId !== opts.fromScriptId) return false;
        return true;
    }
    function makeNaiMsg(data, opts) {
        opts = opts || {};
        var m = { fromScriptId: opts.fromScriptId || TM_SID, data: data, timestamp: Date.now() };
        if (opts.channel != null) m.channel = opts.channel;
        if (opts.toScriptId != null) m.toScriptId = opts.toScriptId;
        return m;
    }
    function makeInvokeCbMsg(cbName, naiMsg) {
        return { id: nextId('msg_tm'), type: INVOKE_CALLBACK, payload: { callbackName: cbName, args: [naiMsg] } };
    }
    function invokeWorkerCallbacks(worker, packet, opts) {
        opts = opts || {};
        var state = getWorkerState(worker), channel = opts.channel != null ? opts.channel : null, sent = 0;
        state.callbacks.forEach(function(meta) {
            if (!cbMatchesFilter(meta, { channel: channel, fromScriptId: TM_SID })) return;
            worker.postMessage(makeInvokeCbMsg(meta.callbackName, makeNaiMsg(packet, { fromScriptId: TM_SID, channel: channel })));
            sent++;
        });
        if (sent === 0) warn('No matching callbacks for worker #' + state.id, { channel: channel, packet: packet });
        return sent;
    }
    function send(sid, payload, opts) {
        var script = inboundScripts.get(sid);
        if (!script) { warn('Dropped message. Script "' + sid + '" not handshaken.'); return 0; }
        return invokeWorkerCallbacks(script.worker, { type: TYPE_MESSAGE, sid: TM_SID, payload: payload }, opts || {});
    }
    function sendAll(payload, opts) { var n = 0; inboundScripts.forEach(function(_, sid) { n += send(sid, payload, opts); }); return n; }
    function emitToListeners(packet, meta) {
        listeners.forEach(function(lst) {
            if (lst.only && lst.only.length && lst.only.indexOf(packet.sid) < 0) return;
            if (lst.ignore && lst.ignore.length && lst.ignore.indexOf(packet.sid) >= 0) return;
            try { lst.call(packet.payload, { sid: packet.sid, channel: meta.channel, worker: meta.worker, raw: packet }); }
            catch(e) { console.error('[NAI TM Bridge] Listener error:', e); }
        });
    }
    function on(listener) {
        var id = nextId('listener');
        if (typeof listener === 'function') { listeners.set(id, { id: id, call: listener, only: null, ignore: null }); return function() { listeners.delete(id); }; }
        if (!isObj(listener) || typeof listener.call !== 'function') throw new TypeError('Listener must be a function or {call} object.');
        listeners.set(id, { id: id, call: listener.call, only: Array.isArray(listener.only) ? listener.only : null, ignore: Array.isArray(listener.ignore) ? listener.ignore : null });
        return function() { listeners.delete(id); };
    }
    function off(id) { return listeners.delete(id); }
    function handleHandshake(worker, packet) {
        var hs = isObj(packet.payload) ? packet.payload.handshake : null;
        if (hs === HANDSHAKE_IN)  { rememberScript(inboundScripts,  packet.sid, worker, 'inbound');  return true; }
        if (hs === HANDSHAKE_OUT) { rememberScript(outboundScripts, packet.sid, worker, 'outbound'); return true; }
        return false;
    }
    function handleBroadcast(worker, data, channel) {
        if (!isObj(data) || typeof data.type !== 'string' || typeof data.sid !== 'string') return;
        if (data.type === TYPE_HANDSHAKE) { handleHandshake(worker, data); return; }
        if (data.type === TYPE_MESSAGE) {
            if (!outboundScripts.has(data.sid)) { log('Ignored message from non-outbound script "' + data.sid + '".'); return; }
            emitToListeners(data, { worker: worker, channel: channel });
        }
    }
    function handleApiCall(worker, message) {
        if (!isObj(message) || message.type !== API_CALL) return;
        var payload = message.payload;
        if (!isObj(payload) || typeof payload.method !== 'string') return;
        var args = Array.isArray(payload.args) ? payload.args : [];
        if (payload.method === METHOD_ON_MSG) { if (typeof args[0] === 'string') registerCallback(worker, args[0], args[1]); return; }
        if (payload.method === METHOD_BROADCAST) { handleBroadcast(worker, args[0], args[1] != null ? args[1] : null); }
    }
    function observeWorker(worker) {
        var state = getWorkerState(worker);
        worker.addEventListener('message', function(ev) { handleApiCall(worker, ev.data); });
        var native = worker.postMessage.bind(worker);
        worker.postMessage = function(message) { log('host -> worker #' + state.id, message); return native.apply(worker, arguments); };
    }
    function getState() {
        function ls(map) { var r = []; map.forEach(function(s) { r.push({ sid: s.sid, direction: s.direction }); }); return r; }
        return { inboundScripts: ls(inboundScripts), outboundScripts: ls(outboundScripts), listeners: Array.from(listeners.keys()) };
    }

    var NativeWorker = window.Worker;
    window.Worker = new Proxy(NativeWorker, {
        construct: function(target, args, newTarget) {
            var worker = Reflect.construct(target, args, newTarget);
            observeWorker(worker);
            return worker;
        }
    });

    var bridge = { send: send, sendAll: sendAll, on: on, off: off, getState: getState };
    Object.defineProperty(window, INSTALL_KEY, { value: bridge, configurable: true });
    Object.defineProperty(window, 'NAITMBridge',  { value: bridge, configurable: true });
    console.log('[NAI TM Bridge] Installed. window.NAITMBridge ready.');
})();

// PART 1 — CE BRIDGE  (waits for DOMContentLoaded)

(function() {
'use strict';

// SECTION 1 — CONSTANTS & CONFIG

const IMG_FIELDS_LS_KEY = 'ae_img_fields_cache_v1';
const DEFAULT_IMG_DEFAULTS = { width: 832, height: 1216, scale: 5.0, steps: 28 };
var _ceLogEnabled = {};
function _ceLogChannelOf(first) {
    if (typeof first !== 'string') return '';
    var m = first.match(/^\[(?:AE:?|CE:)([a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)*)\]/);
    return m ? m[1] : '';
}
function _ceLogChannelOn(channel) {
    if (!channel) return true;
    if (_ceLogEnabled['*']) return true;
    if (_ceLogEnabled[channel]) return true;
    var base = channel.split(':')[0];
    return !!_ceLogEnabled[base];
}
function dbg() {
    try {
        var args = Array.prototype.slice.call(arguments);
        if (!_ceLogChannelOn(_ceLogChannelOf(args[0]))) return;
        console.log.apply(console, args);
    } catch (_eDbg) { }
}

function getAuthToken() {
    try {
        var s = localStorage.getItem('session');
        if (s) {
            var p = JSON.parse(s);
            var tok = p.token || p.auth_token || p.access_token || p.accessToken;
            if (!tok && p.data) tok = p.data.token || p.data.auth_token || p.data.access_token;
            if (!tok && p.user) tok = p.user.token || p.user.auth_token;
            if (tok && String(tok) !== 'undefined') return 'Bearer ' + tok;
        }
    } catch(_) {}
    return null;
}
function _authDebug() {
    try { return 'LS keys: ' + Object.keys(localStorage).filter(function(k){return /session|token|auth/i.test(k);}).join(', ') || 'none found'; }
    catch(_) { return 'localStorage unavailable'; }
}

const NAITMBridge = window.NAITMBridge || null;

var _aeThinkingRefs = 0;
function _aeSetEngineThinking(on) {
    _aeThinkingRefs = Math.max(0, _aeThinkingRefs + (on ? 1 : -1));
}

const getCyberIconHTML = (icon, arg2, arg3) => {
    let size = 16, color = 'currentColor', extraClass = '';
    if (typeof arg2 === 'number' || (typeof arg2 === 'string' && !isNaN(arg2))) {
        size = Number(arg2);
        if (typeof arg3 === 'string') {
            if (arg3.startsWith('#') || arg3.startsWith('var(') || arg3.startsWith('rgb')) color = arg3;
            else extraClass = arg3;
        }
    } else if (typeof arg2 === 'string') {
        color = arg2;
        if (typeof arg3 === 'string') extraClass = arg3;
    }
    const rk = { path: CyberIcons[icon] || '' };
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="${color}" stroke-width="1.75" stroke-linecap="square" stroke-linejoin="miter" class="cyber-icon ${extraClass}">${rk.path || ''}</svg>`;
};

// SECTION 5 — STATE

var engineScriptId  = null;
// [CR-IDENT]
var engineKind      = 'CE';
var activeStoryId   = '';
var _aeImgFields    = [];
var _aeImgDefaults  = Object.assign({}, DEFAULT_IMG_DEFAULTS);

var _bridgeUnsubscribe = null;

var imgCache   = new Map();

var _imgDb = null;

// SECTION 6 — ENGINE MESSAGING

function sendToEngine(event, data) {
    if (!NAITMBridge || !engineScriptId) {
        console.warn('[AE Bridge] sendToEngine: no engine. Event:', event); return;
    }
    try { NAITMBridge.send(engineScriptId, Object.assign({ event: event }, data || {})); }
    catch(e) { console.error('[AE Bridge] sendToEngine failed:', e); }
}

var _ceVpLastW = -1, _ceVpLastH = -1, _ceVpTimer = null;
function _ceViewportSend() {
    try {
        var w = Math.round(window.innerWidth || 0);
        var h = Math.round(window.innerHeight || 0);
        if (!w) return;
        if (w === _ceVpLastW && h === _ceVpLastH) return;
        _ceVpLastW = w; _ceVpLastH = h;
        sendToEngine('AE_VIEWPORT', { w: w, h: h });
    } catch (e) { }
}
function _ceViewportNudge() {
    try {
        if (_ceVpTimer) clearTimeout(_ceVpTimer);
        _ceVpTimer = setTimeout(_ceViewportSend, 250);
    } catch (e) {}
}
function _ceViewportWatch() {
    try {
        window.addEventListener('resize', _ceViewportNudge);
        window.addEventListener('orientationchange', _ceViewportNudge);
    } catch (e) { }
}

function handleEngineMessage(payload, meta) {
    var event = payload && payload.event; if (!event) return;
    if (meta && meta.sid) engineScriptId = meta.sid;
    switch (event) {
        case 'HANDSHAKE_REQUEST':
            engineScriptId = meta.sid;
            // [CR-IDENT]
            engineKind = String((payload && payload.engine) || 'CE');
            console.log('[CE Bridge] Engine handshake received. Sending ACK. SID:', engineScriptId,
                '| Engine:', engineKind, (payload && payload.engineVersion) || '');
            // [CR-CCAV-HOSTCLEAR] ccavClear tells CR a portrait box clears the float above it.
            sendToEngine('HANDSHAKE_ACK', { engine: engineKind, crAware: true, ccavClear: true });
            _ceVpLastW = -1; _ceVpLastH = -1;
            _ceViewportSend();
            break;
        case 'GENERATE_IMAGE':
            (function(p) {
                generateCommentImage(p).then(function(dataUrl) {
                    // [CR-GENLOUD]
                    if (!dataUrl) {
                        _showToast('The image generator returned no picture.');
                        if (p.replyToSid && p.requestId && NAITMBridge) {
                            NAITMBridge.send(String(p.replyToSid), {
                                event: 'CC_AVATAR_GENERATION_RESULT',
                                requestId: String(p.requestId),
                                error: 'The image generator returned no picture.'
                            });
                        }
                        return;
                    }
                    displayGeneratedImage(p.uuid, dataUrl, p);
                    _ccimgInvalidate(); _ceStoryImgNudge();
                    _ceSurfImgInvalidate();
                    if (p.kind === 'snapshot' && p.charId) {
                        _ceSurfImgInvalidate();
                        _savePortrait(p.charId + '_em_Snapshot', dataUrl, 'gen', { fp: p.prompt || '', fu: (p.characters && p.characters[0] && p.characters[0].uc) || '', chars: p.characters || [], settings: p.settings || null }).catch(function() {});
                        _showToast('Snapshot image saved.');
                    }
                    if (p.kind === 'charSlot' && p.charId && p.slot) {
                        _ceSurfImgInvalidate();
                        var _cisKey = p.charId + '_em_' + p.slot;
                        _savePortrait(_cisKey, dataUrl, 'gen', { fp: p.prompt || '', fu: (p.characters && p.characters[0] && p.characters[0].uc) || '', chars: p.characters || [], settings: p.settings || null }).catch(function() {});
                        imgCache.set(_cisKey, { dataUrl: dataUrl, fp: p.prompt || '', fu: (p.characters && p.characters[0] && p.characters[0].uc) || '', prompt: p.prompt || '', characters: p.characters || [], settings: p.settings || null });
                        _showToast('Generated ' + p.slot + '.');
                    }
                    if (p.replyToSid && p.requestId && NAITMBridge) {
                        NAITMBridge.send(String(p.replyToSid), {
                            event: 'CC_AVATAR_GENERATION_RESULT',
                            requestId: String(p.requestId),
                            imageData: dataUrl
                        });
                    }
                }).catch(function(e) {
                    console.error('[CE Bridge] GENERATE_IMAGE failed:', e);
                    // [CR-GENLOUD]
                    var m = (e && e.message) ? String(e.message) : String(e);
                    _showToast('Image generation failed: ' + m.slice(0, 160));
                    if (p.replyToSid && p.requestId && NAITMBridge) {
                        NAITMBridge.send(String(p.replyToSid), {
                            event: 'CC_AVATAR_GENERATION_RESULT',
                            requestId: String(p.requestId),
                            error: m.slice(0, 240)
                        });
                    }
                });
            })(payload);
            break;
        case 'AE_ENGINE_THINKING': {
            _aeSetEngineThinking(!!(payload && payload.on));
            break;
        }
        case 'STORY_ID_SYNC':
            if (payload.storyId) activeStoryId = payload.storyId; break;
        case 'CLICK_GENERATE_NOW':
            setTimeout(function() {
                var btn = findNAIGenerateButton();
                if (btn) { btn.click(); dbg('[CE:gen] Generate clicked.'); }
                else dbg('[CE:gen] Generate button not found.');
            }, 50); break;
        case 'AE_DELETE_PORTRAIT_CASCADE': {
            var charId = payload.charId;
            if (!charId) break;
            var slots = _getEmoSlots(charId);
            var keysToDelete = [charId + '_portrait'];
            slots.forEach(function(slotName) {
                keysToDelete.push(charId + '_em_' + slotName);
            });
            console.log('[CE Bridge] Deleting gallery assets for ' + charId, keysToDelete);
            keysToDelete.forEach(function(key) {
                _deletePortrait(key).catch(function(e) { console.error('[CE Bridge] Failed to delete portrait key ' + key, e); });
            });
            try { localStorage.removeItem('ae_emo_slots_' + charId); } catch (_) {}
            try { localStorage.removeItem('ae_emo_tags_' + charId); } catch (_) {}
            break;
        }
        case 'AE_CHAR_IMAGE_ACTION': {
            var ciaCharId = payload.charId, ciaSlot = payload.slot, ciaOp = payload.op;
            if (!ciaCharId) break;
            // [CR-SLOTS]
            if (ciaOp === 'slots') {
                _portraitSlotsFor(ciaCharId).then(function(slots) {
                    sendToEngine('AE_CHAR_IMAGE_SLOTS', { charId: ciaCharId, slots: slots });
                }).catch(function(e) {
                    console.error('[CE Bridge] CHARIMG slots failed:', e);
                    sendToEngine('AE_CHAR_IMAGE_SLOTS', { charId: ciaCharId, slots: [] });
                });
                break;
            }
            if (!ciaSlot) break;
            var ciaKey = ciaCharId + '_em_' + ciaSlot;
            if (ciaOp === 'delete') {
                _deletePortrait(ciaKey).then(function() {
                    imgCache.delete(ciaKey);
                    _ceSurfImgInvalidate();
                    _showToast('Deleted ' + ciaSlot + ' image.');
                }).catch(function(e) { console.error('[CE Bridge] CHARIMG delete failed:', e); });
            } else if (ciaOp === 'download') {
                _loadPortrait(ciaKey).then(function(url) {
                    if (!url) { _showToast('No image saved for ' + ciaSlot + '.'); return; }
                    _downloadAsPng(url, 'ae-' + ciaCharId.slice(0, 8) + '-' + ciaSlot + '.png');
                }).catch(function(e) { console.error('[CE Bridge] CHARIMG download failed:', e); });
            } else if (ciaOp === 'upload') {
                _ceImgSlotUpload(ciaCharId, ciaSlot, ciaKey);
            } else if (ciaOp === 'edit') {
                _showToast('Editing moved into the Images surface \u2014 use "Use prompt" there.');
            } else {
                console.warn('[CE Bridge] AE_CHAR_IMAGE_ACTION unknown op:', ciaOp);
            }
            break;
        }
        // [CR-CARDIMPORT]
        case 'AE_CARD_IMPORT': {
            var cciTicket = String(payload.ticket || ''), cciOp = payload.op;
            if (!cciTicket) break;
            if (cciOp === 'pick') {
                _crCardImportPick(cciTicket);
            } else if (cciOp === 'commit') {
                _crCardImportCommit(cciTicket, String(payload.charId || ''));
            } else if (cciOp === 'discard') {
                _crCardImportDiscard(cciTicket);
            } else {
                console.warn('[CE Bridge] AE_CARD_IMPORT unknown op:', cciOp);
            }
            break;
        }
        case 'AE_CHAT_BUBBLE_STYLE':
            _ccApplyBubbleTokens(payload);
            break;
        case 'AE_GALLERY_INDEX_REQ':
            _ceGallerySendIndex();
            break;
        case 'AE_IMG_META_REQ': {
            var mUuid = String((payload && payload.uuid) || '');
            if (!mUuid) break;
            dbGet(mUuid).then(function(rec) {
                sendToEngine('AE_IMG_META_RESP', rec ? {
                    uuid: mUuid, found: true,
                    prompt: String(rec.prompt || ''),
                    fp: String(rec.fp || rec.prompt || ''),
                    fu: String(rec.fu || ''),
                    chars: rec.chars || [],
                    settings: rec.settings || {},
                    storyId: String(rec.storyId || ''),
                    createdAt: Number(rec.ts) || 0
                } : { uuid: mUuid, found: false });
            }).catch(function(e) {
                console.error('[CE Bridge] AE_IMG_META_REQ failed:', e);
                sendToEngine('AE_IMG_META_RESP', { uuid: mUuid, found: false });
            });
            break;
        }
        case 'AE_IMG_REGEN': {
            var rUuid = String((payload && payload.uuid) || '');
            if (!rUuid) break;
            var rFp = String((payload && payload.fp) || '');
            var rFu = String((payload && payload.fu) || '');
            if (!rFp) { _showToast('That regeneration had an empty prompt.'); break; }
            dbGet(rUuid).then(function(rec) {
                if (!rec) { _showToast('That image is no longer stored.'); sendToEngine('AE_IMG_REGEN_DONE', { uuid: rUuid, ok: false }); return null; }
                var rSet = Object.assign({}, rec.settings || {});
                if (!(payload && payload.keepSeed)) rSet.seed = 0;
                var body = buildRequestBody(rFp, rFu, rec.chars || [], rSet);
                return callGenerateAPI(body).then(function(dataUrl) {
                    return dbSave(rUuid, String((payload && payload.prompt) || rec.prompt || ''),
                                  dataUrl, rFp, rFu, rec.chars || [], rSet,
                                  { header: rec.header || '', body: rec.body || '' },
                                  String(rec.storyId || '')).then(function() {
                        imgCache.set(rUuid, { dataUrl: dataUrl, fp: rFp, fu: rFu,
                            prompt: String((payload && payload.prompt) || rec.prompt || ''),
                            characters: rec.chars || [], settings: rSet });
                        _ceImgForceRepaint(rUuid);
                        _ceGallerySendIndex();
                        _showToast('Regenerated.');
                        sendToEngine('AE_IMG_REGEN_DONE', { uuid: rUuid, ok: true });
                        return null;
                    });
                });
            }).catch(function(e) {
                console.error('[CE Bridge] AE_IMG_REGEN failed:', e);
                _showToast('Regeneration failed \u2014 the original image is untouched.');
                sendToEngine('AE_IMG_REGEN_DONE', { uuid: rUuid, ok: false });
            });
            break;
        }
        case 'AE_GALLERY_ACTION': {
            var galUuid = payload && payload.uuid, galOp = payload && payload.op;
            if (galOp === 'exportAll') { _ceGalleryExportAll(); break; }
            if (galOp === 'clearAll') {
                dbClearAll().then(function(ok) {
                    if (!ok) { _showToast('Could not clear the gallery.'); return null; }
                    imgCache.clear();
                    _ceSurfImgInvalidate();
                    _ccimgInvalidate();
                    _showToast('Gallery cleared.');
                    _ceGallerySendIndex();
                    return null;
                }).catch(function(e) { console.error('[CE Bridge] gallery clear failed:', e); });
                break;
            }
            if (!galUuid) break;
            if (galOp === 'delete') {
                dbDelete(galUuid).then(function() {
                    imgCache.delete(galUuid);
                    _ceSurfImgInvalidate();
                    _ccimgInvalidate();
                    _showToast('Image deleted.');
                    _ceGallerySendIndex();
                }).catch(function(e) { console.error('[CE Bridge] gallery delete failed:', e); });
            } else if (galOp === 'download') {
                dbGet(galUuid).then(function(rec) {
                    if (!rec || !rec.dataUrl) { _showToast('That image is no longer stored.'); return; }
                    _downloadAsPng(rec.dataUrl, 'ae-' + String(galUuid).slice(0, 8) + '.png');
                }).catch(function(e) { console.error('[CE Bridge] gallery download failed:', e); });
            } else if (galOp === 'edit') {
                sendToEngine('AE_IMG_EDIT_OPEN', { uuid: galUuid });
            } else {
                console.warn('[CE Bridge] AE_GALLERY_ACTION unknown op:', galOp);
            }
            break;
        }
        default: console.log('[CE Bridge] Unhandled engine event:', event, payload);
    }

}

function _ceImgSlotUpload(charId, slot, key) {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,image/gif';
    input.style.display = 'none';
    input.addEventListener('change', function() {
        var f = input.files && input.files[0];
        if (!f) { try { input.remove(); } catch (_) {} return; }
        var fr = new FileReader();
        fr.onload = function() {
            var url = String(fr.result || '');
            if (url.indexOf('data:image/') !== 0) {
                _showToast('That file is not an image.');
                try { input.remove(); } catch (_) {}
                return;
            }
            _savePortrait(key, url, 'upload', null).then(function() {
                imgCache.delete(key);
                _ceSurfImgInvalidate();
                _showToast('Uploaded ' + slot + ' image.');
                sendToEngine('AE_CHAR_IMAGE_UPLOADED', { charId: charId, slot: slot });
            }).catch(function(e) {
                console.error('[CE Bridge] CHARIMG upload save failed:', e);
                _showToast('Could not save that image.');
            }).then(function() {
                try { input.remove(); } catch (_) {}
            });
        };
        fr.onerror = function() {
            _showToast('Could not read that file.');
            try { input.remove(); } catch (_) {}
        };
        fr.readAsDataURL(f);
    });
    document.body.appendChild(input);
    input.click();
}

// [CR-CARDIMPORT]
var _crCardImportHeld = {};
var CR_CARD_IMPORT_TTL_MS = 600000;
var CR_CARD_SLOT_RE = /^[A-Za-z0-9_-]{1,32}$/;

function _crCardImportSweep() {
    var now = Date.now(), k;
    for (k in _crCardImportHeld) {
        if (!Object.prototype.hasOwnProperty.call(_crCardImportHeld, k)) continue;
        if (now - _crCardImportHeld[k].at > CR_CARD_IMPORT_TTL_MS) delete _crCardImportHeld[k];
    }
}

function _crCardImportStrip(data) {
    var held = [], names, i, n, v;
    if (!data || typeof data !== 'object') return held;
    v = data.avatarUri;
    if (typeof v === 'string') {
        if (v.indexOf('data:image/') === 0) held.push({ slot: 'Avatar', url: v });
        data.avatarUri = '';
    }
    if (data.emotions && typeof data.emotions === 'object') {
        names = Object.keys(data.emotions);
        for (i = 0; i < names.length; i++) {
            n = names[i];
            v = data.emotions[n];
            if (typeof v !== 'string' || v.indexOf('data:image/') !== 0) continue;
            if (CR_CARD_SLOT_RE.test(n)) held.push({ slot: n, url: v });
            delete data.emotions[n];
        }
    }
    return held;
}

function _crCardImportPick(ticket) {
    _crCardImportSweep();
    sendToEngine('AE_CARD_IMPORT_RESULT', { ticket: ticket, phase: 'ack', ok: true });
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.style.display = 'none';
    input.addEventListener('change', function() {
        var f = input.files && input.files[0];
        if (!f) {
            try { input.remove(); } catch (_) {}
            sendToEngine('AE_CARD_IMPORT_RESULT', { ticket: ticket, phase: 'pick', ok: false, cancelled: true });
            return;
        }
        var fr = new FileReader();
        fr.onload = function() {
            try { input.remove(); } catch (_) {}
            var data, held, slim, i, slots;
            try { data = JSON.parse(String(fr.result || '')); }
            catch (_e) {
                sendToEngine('AE_CARD_IMPORT_RESULT', { ticket: ticket, phase: 'pick', ok: false, error: 'That file is not valid JSON.' });
                return;
            }
            held = _crCardImportStrip(data);
            try { slim = JSON.stringify(data); }
            catch (_e2) {
                sendToEngine('AE_CARD_IMPORT_RESULT', { ticket: ticket, phase: 'pick', ok: false, error: 'That card could not be re-serialised.' });
                return;
            }
            slots = [];
            for (i = 0; i < held.length; i++) slots.push(held[i].slot);
            _crCardImportHeld[ticket] = { at: Date.now(), images: held };
            sendToEngine('AE_CARD_IMPORT_RESULT', { ticket: ticket, phase: 'pick', ok: true, json: slim, slots: slots });
        };
        fr.onerror = function() {
            try { input.remove(); } catch (_) {}
            sendToEngine('AE_CARD_IMPORT_RESULT', { ticket: ticket, phase: 'pick', ok: false, error: 'Could not read that file.' });
        };
        fr.readAsText(f);
    });
    document.body.appendChild(input);
    input.click();
}

function _crCardImportCommit(ticket, charId) {
    var rec = _crCardImportHeld[ticket];
    delete _crCardImportHeld[ticket];
    if (!rec) {
        sendToEngine('AE_CARD_IMPORT_RESULT', { ticket: ticket, phase: 'commit', ok: false, error: 'That import is no longer held.' });
        return;
    }
    if (!charId) {
        sendToEngine('AE_CARD_IMPORT_RESULT', { ticket: ticket, phase: 'commit', ok: false, error: 'No character id to store against.' });
        return;
    }
    var imgs = rec.images || [], saved = 0, failed = 0, chain = Promise.resolve();
    imgs.forEach(function(im) {
        chain = chain.then(function() {
            var key = charId + '_em_' + im.slot;
            return _savePortrait(key, im.url, 'upload', null).then(function() {
                saved = saved + 1;
                imgCache.delete(key);
            }).catch(function(e) {
                failed = failed + 1;
                console.error('[CE Bridge] CARDIMPORT save failed for ' + im.slot + ':', e);
            });
        });
    });
    chain.then(function() {
        _ceSurfImgInvalidate();
        if (saved) _showToast('Imported ' + saved + ' image' + (saved === 1 ? '' : 's') + '.');
        if (failed) _showToast('Could not store ' + failed + ' of them.');
        sendToEngine('AE_CARD_IMPORT_RESULT', { ticket: ticket, phase: 'commit', ok: true, charId: charId, saved: saved, failed: failed });
    });
}

function _crCardImportDiscard(ticket) {
    delete _crCardImportHeld[ticket];
    _crCardImportSweep();
}

// SECTION 7 — IMAGE GENERATION

var CE_CC_TOKEN_MAP = {
    maxWidth: '--ae-cc-max',        lane:     '--ae-cc-lane',
    avaLeft:  '--ae-cc-avaleft',    padX:     '--ae-cc-padx',
    radius:   '--ae-cc-radius',     notch:    '--ae-cc-notch',
    povBg:    '--ae-cc-pov-bg',     themBg:   '--ae-cc-them-bg',
    povEdge:  '--ae-cc-pov-edge',   themEdge: '--ae-cc-them-edge',
    povInk:   '--ae-cc-pov-ink',    themInk:  '--ae-cc-them-ink',
    accent:   '--ae-cc-accent',     font:     '--ae-cc-font'
};

function _ccApplyBubbleTokens(p) {
    try {
        var root = document.documentElement;
        if (!root || !root.style) return;
        var k;
        for (k in CE_CC_TOKEN_MAP) {
            if (!Object.prototype.hasOwnProperty.call(CE_CC_TOKEN_MAP, k)) continue;
            var v = p ? p[k] : null;
            if (v === null || v === undefined || v === '') continue;
            root.style.setProperty(CE_CC_TOKEN_MAP[k], String(v));
        }
        try { root.classList.toggle('ce-cb-stage', String(p && p.stage) === '1'); } catch (_eS) {}
        dbg('[CE:chatstyle] bubble tokens applied');
    } catch (e) { console.warn('[CE Bridge] bubble token apply failed:', e); }
}

function loadCachedImgFields() {
    try { var s = localStorage.getItem(IMG_FIELDS_LS_KEY); if (s) { var p = JSON.parse(s); if (Array.isArray(p.fields)) _aeImgFields = p.fields; if (p.defaults) _aeImgDefaults = Object.assign({}, DEFAULT_IMG_DEFAULTS, p.defaults); } } catch(_) {}
}

// SECTION 7b — GENERATION PILL

var _ceGenPillN = 0;
var _ceGenPillEl = null;
var _ceGenPillMuted = false;

function _ceGenPillEnsure() {
    if (_ceGenPillEl && _ceGenPillEl.isConnected) return _ceGenPillEl;
    var el = document.createElement('div');
    el.id = 'ce-gen-pill';
    el.style.cssText = [
        'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483000',
        'display:flex', 'align-items:center', 'gap:10px',
        'padding:8px 10px 8px 12px', 'border-radius:999px',
        'background:rgba(20,20,24,0.88)', 'color:#f2f2f5',
        'font:500 13px/1.2 system-ui,-apple-system,Segoe UI,sans-serif',
        'box-shadow:0 4px 16px rgba(0,0,0,0.35)',
        'backdrop-filter:blur(6px)', '-webkit-backdrop-filter:blur(6px)',
        'pointer-events:auto', 'user-select:none'
    ].join(';');

    var dot = document.createElement('span');
    dot.id = 'ce-gen-pill-dot';
    dot.style.cssText = [
        'width:8px', 'height:8px', 'border-radius:50%',
        'background:#5aa6de', 'flex:0 0 auto',
        'animation:ce-gen-pill-pulse 1.1s ease-in-out infinite'
    ].join(';');

    var txt = document.createElement('span');
    txt.id = 'ce-gen-pill-txt';
    txt.textContent = 'Generating image\u2026';

    var x = document.createElement('button');
    x.type = 'button';
    x.setAttribute('aria-label', 'Dismiss the generation indicator');
    x.textContent = '\u00d7';
    x.style.cssText = [
        'all:unset', 'cursor:pointer', 'flex:0 0 auto',
        'width:20px', 'height:20px', 'line-height:20px', 'text-align:center',
        'border-radius:50%', 'opacity:0.7', 'font-size:16px'
    ].join(';');
    x.addEventListener('click', function(ev) {
        ev.stopPropagation();
        _ceGenPillN = 0;
        _ceGenPillMuted = true;
        _ceGenPillRender();
    });

    el.appendChild(dot); el.appendChild(txt); el.appendChild(x);
    try {
        if (!document.getElementById('ce-gen-pill-css')) {
            var st = document.createElement('style');
            st.id = 'ce-gen-pill-css';
            st.textContent = '@keyframes ce-gen-pill-pulse{0%,100%{opacity:1}50%{opacity:0.25}}';
            document.head.appendChild(st);
        }
    } catch (_ep) {}
    document.body.appendChild(el);
    _ceGenPillEl = el;
    return el;
}

function _ceGenPillRender() {
    try {
        if (_ceGenPillN <= 0 || _ceGenPillMuted) {
            if (_ceGenPillEl) _ceGenPillEl.style.display = 'none';
            return;
        }
        var el = _ceGenPillEnsure();
        var t = el.querySelector('#ce-gen-pill-txt');
        if (t) {
            t.textContent = (_ceGenPillN > 1)
                ? ('Generating ' + _ceGenPillN + ' images\u2026')
                : 'Generating image\u2026';
        }
        el.style.display = 'flex';
    } catch (e) { console.error('[CE Bridge] gen pill render failed:', e); }
}

function _ceGenPillBump(delta) {
    try {
        var before = _ceGenPillN;
        _ceGenPillN = Math.max(0, _ceGenPillN + delta);
        if (before === 0 && _ceGenPillN > 0) _ceGenPillMuted = false;
        _ceGenPillRender();
    } catch (e) { console.error('[CE Bridge] gen pill bump failed:', e); }
}

async function callGenerateAPI(body) {
    _aeSetEngineThinking(true);
    _ceGenPillBump(1);
    try {
        var auth = getAuthToken();
        if (!auth || auth === 'Bearer undefined') throw new Error('No NAI auth token. ' + _authDebug());
        var resp = await fetch('https://image.novelai.net/ai/generate-image-stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': auth },
            body: JSON.stringify(body)
        });
        if (!resp.ok) throw new Error('NAI API ' + resp.status);
        var reader = resp.body.getReader(), dec = new TextDecoder();
        var buf = '', chunks = [], lastJpeg = null;
        while (true) {
            var rd = await reader.read(); if (rd.done) break;
            buf += dec.decode(rd.value, { stream: true });
            var lines = buf.split('\n'); buf = lines.pop();
            for (var l of lines) {
                if (l.startsWith('data:')) chunks.push(l.slice(5).trim());
                else if (l.trim() === '' && chunks.length) { try { var ev = JSON.parse(chunks.join('')); if (ev.image) lastJpeg = ev.image; } catch(_) {} chunks = []; }
            }
        }
        if (!lastJpeg) throw new Error('No image returned.');
        return 'data:image/png;base64,' + lastJpeg;
    } finally {
        _aeSetEngineThinking(false);
        _ceGenPillBump(-1);
    }
}

function buildRequestBody(fp, fu, chars, settings) {
    var charPos = []; var charNeg = [];
    (chars || []).forEach(function(c) {
        if (c.visuals && c.visuals.trim()) { charPos.push({ char_caption: c.visuals, centers: [{ x: 0.5, y: 0.5 }] }); charNeg.push({ char_caption: c.uc || '', centers: [{ x: 0.5, y: 0.5 }] }); }
    });
    var seed = settings.seed && settings.seed !== 0 ? settings.seed : Math.floor(Math.random() * 4294967295);
    var naiModel = (settings && settings.model) ? String(settings.model) : 'nai-diffusion-4-5-full';
    return {
        input: fp, model: naiModel, action: 'generate',
        parameters: {
            width: settings.width, height: settings.height,
            scale: settings.scale, steps: settings.steps,
            sampler: 'k_euler_ancestral', noise_schedule: 'karras', n_samples: 1, seed: seed,
            params_version: 3, qualityToggle: false, uc: fu, characterPrompts: [],
            reference_image_multiple: [], reference_information_extracted_multiple: [], reference_strength_multiple: [],
            v4_prompt:          { caption: { base_caption: fp, char_captions: charPos }, use_coords: false, use_order: true },
            v4_negative_prompt: { caption: { base_caption: fu, char_captions: charNeg }, use_coords: false, use_order: true }
        }
    };
}

async function generateCommentImage(imagePayload) {
    var fp = [imagePayload.settings.quality, imagePayload.extraBaseVisuals, imagePayload.prompt].filter(Boolean).join(', ');
    var fu = [imagePayload.settings.negative, imagePayload.extraBaseUC].filter(Boolean).join(', ');
    var body = buildRequestBody(fp, fu, imagePayload.characters || [], imagePayload.settings);
    var dataUrl = await callGenerateAPI(body);
    dbSave(imagePayload.uuid, imagePayload.prompt, dataUrl, fp, fu, imagePayload.characters || [], imagePayload.settings, { header: imagePayload.header || '', body: imagePayload.body || '' }, imagePayload.storyId || '').catch(function() {});
    imgCache.set(imagePayload.uuid, { dataUrl: dataUrl, fp: fp, fu: fu, prompt: imagePayload.prompt, characters: imagePayload.characters || [], settings: imagePayload.settings });
    return dataUrl;
}

function displayGeneratedImage(uuid, dataUrl, payload) {
    if (payload.autoDownload) { _downloadAsPng(dataUrl, 'ae-' + uuid.slice(0, 8) + '.png'); }
}

function findNAIGenerateButton() {
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        var txt = (b.textContent || b.getAttribute('aria-label') || '').trim().toLowerCase();
        if (txt === 'generate' || txt.includes('generate') && b.offsetParent) return b;
    }
    return null;
}

// SECTION 8 — INDEXEDDB (image + roster persistence)

function openImgDB() {
    return new Promise(function(resolve, reject) {
        if (_imgDb) { resolve(_imgDb); return; }
        var req = indexedDB.open('nai_illustrator', 3);
        req.onupgradeneeded = function(e) { var db = e.target.result; if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'uuid' }); };
        req.onsuccess = function(e) { _imgDb = e.target.result; resolve(_imgDb); };
        req.onerror = reject;
    });
}

async function dbSave(uuid, prompt, dataUrl, fp, fu, chars, settings, caption, storyId) {
    try {
        var storeUrl = await _toWebPForStore(dataUrl);
        var thumbUrl = null;
        try { thumbUrl = await _ceMakeThumb(storeUrl); } catch (_t) { thumbUrl = null; }
        var db = await openImgDB(); var tx = db.transaction('images', 'readwrite'); tx.objectStore('images').put({ uuid: uuid, prompt: prompt, dataUrl: storeUrl, thumb: thumbUrl, fp: fp, fu: fu, chars: chars, settings: settings, storyId: (storyId || activeStoryId || ''), header: (caption && caption.header) || '', body: (caption && caption.body) || '', ts: Date.now() }); }
    catch(_) {}
}

function dbGetAll() {
    return openImgDB().then(function(db) {
        return new Promise(function(resolve) {
            var req = db.transaction('images', 'readonly').objectStore('images').getAll();
            req.onsuccess = function(e) { resolve(e.target.result || []); };
            req.onerror   = function() { resolve([]); };
        });
    }).catch(function() { return []; });
}

function dbGet(uuid) {
    if (!uuid) return Promise.resolve(null);
    return openImgDB().then(function(db) {
        return new Promise(function(resolve) {
            var req = db.transaction('images', 'readonly').objectStore('images').get(String(uuid));
            req.onsuccess = function(e) { resolve(e.target.result || null); };
            req.onerror   = function() { resolve(null); };
        });
    }).catch(function() { return null; });
}

function dbGetAllKeys() {
    return openImgDB().then(function(db) {
        return new Promise(function(resolve) {
            var req;
            try { req = db.transaction('images', 'readonly').objectStore('images').getAllKeys(); }
            catch (_e) { resolve([]); return; }
            req.onsuccess = function(e) { resolve(e.target.result || []); };
            req.onerror = function() { resolve([]); };
        });
    }).catch(function() { return []; });
}

function dbEachRecord(fn) {
    return openImgDB().then(function(db) {
        return new Promise(function(resolve) {
            var req;
            try { req = db.transaction('images', 'readonly').objectStore('images').openCursor(); }
            catch (_e) { resolve(false); return; }
            req.onsuccess = function(e) {
                var cur = e.target.result;
                if (!cur) { resolve(true); return; }
                try { fn(cur.value); } catch (_e2) {}
                cur.continue();
            };
            req.onerror = function() { resolve(false); };
        });
    }).catch(function() { return false; });
}

function dbStampField(uuid, field, value) {
    if (!uuid || !field) return Promise.resolve(false);
    return openImgDB().then(function(db) {
        return new Promise(function(resolve) {
            var tx, store, req;
            try {
                tx = db.transaction('images', 'readwrite');
                store = tx.objectStore('images');
                req = store.get(String(uuid));
            } catch (_e) { resolve(false); return; }
            req.onsuccess = function(e) {
                var rec = e.target.result;
                if (!rec) { resolve(false); return; }
                rec[field] = value;
                try { store.put(rec); } catch (_e2) {}
                resolve(true);
            };
            req.onerror = function() { resolve(false); };
        });
    }).catch(function() { return false; });
}

function dbClearAll() {
    return openImgDB().then(function(db) {
        return new Promise(function(resolve) {
            var tx;
            try { tx = db.transaction('images', 'readwrite'); tx.objectStore('images').clear(); }
            catch (_e) { resolve(false); return; }
            tx.oncomplete = function() { resolve(true); };
            tx.onerror = function() { resolve(false); };
            tx.onabort = function() { resolve(false); };
        });
    }).catch(function() { return false; });
}

function dbDelete(uuid) {
    return openImgDB().then(function(db) {
        return new Promise(function(resolve) {
            var tx = db.transaction('images', 'readwrite');
            tx.objectStore('images').delete(uuid);
            tx.oncomplete = resolve; tx.onerror = resolve;
        });
    }).catch(function() {});
}

// SECTION 8b — PORTRAIT IndexedDB  (nai_roster_db / portraits)

var _rosterDb2 = null;
function _openRosterDB() {
    return new Promise(function(resolve, reject) {
        if (_rosterDb2) { resolve(_rosterDb2); return; }
        var req = indexedDB.open('nai_roster_db', 1);
        req.onupgradeneeded = function(e) { var d = e.target.result; if (!d.objectStoreNames.contains('portraits')) d.createObjectStore('portraits', { keyPath: 'id' }); };
        req.onsuccess = function(e) { _rosterDb2 = e.target.result; resolve(_rosterDb2); };
        req.onerror   = function(e) { reject(e.target.error); };
    });
}
// [CR-SLOTS]
function _portraitSlotsFor(charId) {
    var prefix = String(charId || '') + '_em_';
    if (!charId) return Promise.resolve([]);
    return _openRosterDB().then(function(d) {
        return new Promise(function(resolve) {
            var req;
            try { req = d.transaction('portraits', 'readonly').objectStore('portraits').getAllKeys(); }
            catch (_e) { resolve([]); return; }
            req.onsuccess = function(e) {
                var keys = e.target.result || [], out = [];
                for (var i = 0; i < keys.length; i++) {
                    var k = String(keys[i] || '');
                    if (k.indexOf(prefix) === 0) out.push(k.substring(prefix.length));
                }
                out.sort();
                resolve(out);
            };
            req.onerror = function() { resolve([]); };
        });
    }).catch(function() { return []; });
}
function _savePortrait(id, dataUrl, source, meta) {
    return _toWebPForStore(dataUrl).then(function(storeUrl) {
    return _openRosterDB().then(function(d) {
        return new Promise(function(res, rej) {
            var tx = d.transaction('portraits', 'readwrite');
            tx.objectStore('portraits').put({ id: id, dataUrl: storeUrl, ts: Date.now(), source: source || 'gen', meta: meta || null });
            tx.oncomplete = res; tx.onerror = function(e) { rej(e.target.error); };
        });
    });
    });
}
function _loadPortrait(id) {
    return _openRosterDB().then(function(d) {
        return new Promise(function(res) {
            var req = d.transaction('portraits', 'readonly').objectStore('portraits').get(id);
            req.onsuccess = function(e) { res(e.target.result ? e.target.result.dataUrl : null); };
            req.onerror   = function() { res(null); };
        });
    }).catch(function() { return null; });
}
function _deletePortrait(id) {
    return _openRosterDB().then(function(d) {
        return new Promise(function(res) {
            var tx = d.transaction('portraits', 'readwrite');
            tx.objectStore('portraits').delete(id); tx.oncomplete = res; tx.onerror = res;
        });
    }).catch(function() {});
}

function _canvasHasAlpha(c) {
    try {
        var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        for (var i = 3; i < d.length; i += 4) { if (d[i] !== 255) return true; }
        return false;
    } catch (_) {
        return true;
    }
}

function _toWebP(dataUrl, quality) {
    return new Promise(function(resolve, reject) {
        var img = new Image();
        img.onload = function() {
            var c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
            c.getContext('2d').drawImage(img, 0, 0);
            if (_canvasHasAlpha(c)) { resolve(dataUrl); return; }
            resolve(c.toDataURL('image/webp', quality || 0.90));
        };
        img.onerror = reject; img.src = dataUrl;
    });
}

function _toWebPForStore(dataUrl) {
    try {
        if (typeof dataUrl !== 'string' || dataUrl.indexOf('data:image/') !== 0) return Promise.resolve(dataUrl);
        if (dataUrl.indexOf('data:image/webp') === 0) return Promise.resolve(dataUrl);
        return _toWebP(dataUrl, 0.90).then(function(out) {
            if (typeof out !== 'string' || out.indexOf('data:image/webp') !== 0) return dataUrl;
            return out;
        }).catch(function() { return dataUrl; });
    } catch (_) { return Promise.resolve(dataUrl); }
}

var CE_THUMB_MAX = 320;
function _ceMakeThumb(dataUrl) {
    return new Promise(function(resolve) {
        try {
            if (typeof dataUrl !== 'string' || dataUrl.indexOf('data:image/') !== 0) { resolve(null); return; }
            var img = new Image();
            img.onload = function() {
                try {
                    var w = img.naturalWidth, h = img.naturalHeight;
                    if (!w || !h) { resolve(null); return; }
                    if (w <= CE_THUMB_MAX && h <= CE_THUMB_MAX) { resolve(null); return; }
                    var k = CE_THUMB_MAX / Math.max(w, h);
                    var c = document.createElement('canvas');
                    c.width = Math.max(1, Math.round(w * k));
                    c.height = Math.max(1, Math.round(h * k));
                    var ctx = c.getContext('2d');
                    ctx.drawImage(img, 0, 0, c.width, c.height);
                    var out = _canvasHasAlpha(c) ? c.toDataURL('image/png')
                                                 : c.toDataURL('image/webp', 0.72);
                    resolve((typeof out === 'string' && out.indexOf('data:image/') === 0) ? out : null);
                } catch (_e) { resolve(null); }
            };
            img.onerror = function() { resolve(null); };
            img.src = dataUrl;
        } catch (_e2) { resolve(null); }
    });
}

function _downloadAsPng(dataUrl, filename) {
    function fire(href) {
        var a = document.createElement('a');
        a.href = href; a.download = filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
    }
    try {
        if (typeof dataUrl !== 'string' || dataUrl.indexOf('data:image/png') === 0) { fire(dataUrl); return; }
        var img = new Image();
        img.onload = function() {
            try {
                var c = document.createElement('canvas');
                c.width = img.naturalWidth; c.height = img.naturalHeight;
                c.getContext('2d').drawImage(img, 0, 0);
                fire(c.toDataURL('image/png'));
            } catch (_) { fire(dataUrl); }
        };
        img.onerror = function() { fire(dataUrl); };
        img.src = dataUrl;
    } catch (_) { fire(dataUrl); }
}

var _AE_EMOTION_TAGS = {
    neutral:'neutral expression, calm, composed', happy:'happy, bright smile, cheerful',
    sad:'sad expression, downcast eyes, melancholy', angry:'angry expression, furrowed brows, glaring',
    surprised:'surprised, wide eyes, mouth slightly open', embarrassed:'embarrassed, blushing cheeks, flustered',
    shy:'shy, looking away bashfully', disgusted:'disgusted expression, grimacing',
    laughing:'laughing, big smile, eyes crinkled', tired:'tired, heavy half-lidded eyes, exhausted',
    excited:'excited, bright sparkling eyes, energetic', nervous:'nervous, anxious, tense expression',
    confused:'confused, head tilted, puzzled look', worried:'worried, frowning slightly, concerned',
    scared:'scared, wide fearful eyes, trembling', love:'loving expression, soft smile, warm adoring eyes',
    smug:'smug, self-satisfied smirk', bored:'bored, disinterested, deadpan',
    irritated:'irritated, annoyed, exasperated', determined:'determined, focused, resolute',
    playful:'playful, mischievous smile', hurt:'hurt, pained emotional expression',
    aroused:'flushed cheeks, heated gaze', thinking:'thinking, finger to chin, contemplative'
};

var CANON_EMOTION_SLOTS = Object.keys(_AE_EMOTION_TAGS);
var AVATAR_SLOT_NAME = 'Avatar';
function _getEmoSlots(charId) {
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem('ae_emo_slots_' + charId)); } catch(_) {}
    if (raw && raw.length) {
        var changed = false;
        if (raw.indexOf(AVATAR_SLOT_NAME) === -1) { raw = [AVATAR_SLOT_NAME].concat(raw); changed = true; }
        CANON_EMOTION_SLOTS.forEach(function(nm) { if (raw.indexOf(nm) === -1) { raw.push(nm); changed = true; } });
        if (changed) _setEmoSlots(charId, raw);
        return raw;
    }
    var seeded = [AVATAR_SLOT_NAME, 'Snapshot'].concat(CANON_EMOTION_SLOTS);
    _setEmoSlots(charId, seeded);
    return seeded;
}
function _setEmoSlots(charId, list) { try { localStorage.setItem('ae_emo_slots_' + charId, JSON.stringify(list)); } catch(_) {} }
function _loadCharAvatarImage(charId) {
    return _loadPortrait(charId + '_em_' + AVATAR_SLOT_NAME).then(function(url) {
        if (url) return url;
        return _loadPortrait(charId + '_portrait');
    }).catch(function() { return null; });
}
function _loadCharEmotionImage(charId, emotion) {
    if (!emotion) return _loadCharAvatarImage(charId);
    return _loadPortrait(charId + '_em_' + emotion).then(function(url) {
        if (url) return url;
        return _loadCharAvatarImage(charId);
    }).catch(function() { return _loadCharAvatarImage(charId); });
}

function _galleryLightbox(src, caption) {
    var lb = document.createElement('div'); lb.className = 'ae-lightbox'; lb.style.zIndex = '9999999';
    var img = document.createElement('img'); img.src = src; lb.appendChild(img);
    if (caption) { var cap = document.createElement('div'); cap.style.cssText = 'color:rgba(255,255,255,0.55);font-size:12px;font-family:var(--ae-font-sans);margin-top:6px;'; cap.textContent = caption; lb.appendChild(cap); }
    lb.addEventListener('click', function() { lb.remove(); }); document.body.appendChild(lb);
}

function _showToast(msg, dur) {
    var t = document.createElement('div');
    t.style.cssText = [
        'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);',
        'background:var(--ae-bg-panel);border:1px solid var(--ae-bg-border);',
        'color:var(--ae-text-main);padding:8px 18px;border-radius:var(--ae-radius-pill);',
        'font-size:12px;z-index:var(--ae-z-toast);box-shadow:var(--ae-shadow-sm);',
        'pointer-events:none;font-family:var(--ae-font-sans);',
        'max-width:min(360px, calc(100vw - 40px));white-space:normal;overflow-wrap:break-word;text-align:center;line-height:1.45;'
    ].join('');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function() { if (t.parentNode) t.remove(); }, dur || 3000);
}

// SECTION 13c — CHARACTER CHAT: NATIVE HOOKS

function _ccStatusPlace() {
    if (!_ccStatusEl) return;
    var btn = _ccFindNativeSend();
    if (!btn || !_ccVisible(btn)) { _ccStatusEl.classList.remove('show'); return; }
    var r = btn.getBoundingClientRect();
    var cx = r.left + r.width / 2;
    var top = r.top - _ccStatusEl.offsetHeight - 8;
    if (top < 4) top = r.bottom + 8;
    if (cx < 64) cx = 64;
    if (cx > window.innerWidth - 64) cx = window.innerWidth - 64;
    _ccStatusEl.style.left = cx + 'px';
    _ccStatusEl.style.top  = top + 'px';
    _ccStatusEl.classList.add('show');
}

function _ccStatusLoop() {
    _ccStatusRaf = 0;
    if (!_ccStatusEl) return;
    _ccStatusPlace();
    if (_ccStatusLabel()) _ccStatusRaf = requestAnimationFrame(_ccStatusLoop);
}

var AE_CHARCHAT_IMG_SENTINEL = 'ce-chatimg:';
var _ccimgIndex = null;
var _ccimgIndexTs = 0;
var _ccimgWrapMap = new WeakMap();

function _ccimgBuildIndex() {
    var now = Date.now();
    if (_ccimgIndex && (now - _ccimgIndexTs) < 2000) return Promise.resolve(_ccimgIndex);
    return dbGetAllKeys().then(function(keys) {
        var m = new Map();
        for (var i = 0; i < keys.length; i++) {
            var full = String(keys[i] || '');
            if (!full) continue;
            var short = full.replace(/-/g, '').substring(0, 8).toLowerCase();
            if (!m.has(short)) m.set(short, full);
        }
        _ccimgIndex = m; _ccimgIndexTs = Date.now();
        return m;
    }).catch(function() { return _ccimgIndex || new Map(); });
}

function _ccimgInvalidate() { _ccimgIndex = null; _ccimgIndexTs = 0; }

function _ccimgLoad(full) {
    var hit = imgCache.get(full);
    if (hit && hit.dataUrl) return Promise.resolve(hit.dataUrl);
    return dbGet(full).then(function(rec) {
        return rec ? (rec.dataUrl || null) : null;
    }).catch(function() { return null; });
}

// Must match the engines' photo sentinel.
var AE_STORY_IMG_SENTINEL = 'ce-storyimg:';
var _ceStoryImgObs = null;
var _ceStoryImgTmr = null;
var _ceStoryImgWrapMap = new WeakMap();

function _ceStoryImgFind() {
    var out = [];
    var walker;
    try {
        walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
            acceptNode: function(n) {
                return (n.nodeValue && n.nodeValue.indexOf(AE_STORY_IMG_SENTINEL) === 0)
                    ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
            }
        });
    } catch (_e) { return out; }
    var n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
}

// Bounded climb: an unbounded walk ends at body.
function _ceStoryImgContainerFor(textNode) {
    var el = textNode.parentElement;
    var best = el;
    var hops = 0;
    while (el && hops < 4) {
        if (el.hasAttribute && el.hasAttribute('data-ce-storyimg')) return el;
        var t = (el.textContent || '').trim();
        if (t.indexOf(AE_STORY_IMG_SENTINEL) !== 0 || t.length > 80) break;
        best = el;
        el = el.parentElement;
        hops++;
    }
    return best;
}

function _ceStoryImgCorner(cls, iconName, titleText, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'ae-storyimg-corner ' + cls;
    b.title = titleText; b.setAttribute('aria-label', titleText);
    var ic = _ceMiniIcon(iconName, 14); if (ic) b.appendChild(ic);
    b.addEventListener('click', function(e) { e.stopPropagation(); onClick(); });
    return b;
}

// Remove only our own node: the host is the editor's and holds the sentinel.
function _ceStoryImgClearWrap(host) {
    var prev = _ceStoryImgWrapMap.get(host);
    if (prev && prev.parentNode === host) host.removeChild(prev);
    _ceStoryImgWrapMap.delete(host);
}

function _ceStoryImgPending(host, shortId) {
    if (!host.isConnected) return;
    if (host.getAttribute && host.getAttribute('data-ce-storyimg') === 'pending:' + shortId) return;
    host.setAttribute('data-ce-storyimg', 'pending:' + shortId);
    _ceStoryImgClearWrap(host);
    host.className = (host.className || '') + ' ae-storyimg';

    var frame = document.createElement('div');
    frame.className = 'ae-storyimg-frame ae-storyimg-pendframe';
    var box = document.createElement('div');
    box.className = 'ae-storyimg-pend';
    var spin = document.createElement('span');
    spin.className = 'ae-storyimg-spin';
    box.appendChild(spin);
    var lbl = document.createElement('span');
    lbl.textContent = 'Generating\u2026';
    box.appendChild(lbl);
    frame.appendChild(box);
    host.appendChild(frame);
    _ceStoryImgWrapMap.set(host, frame);
}

// The editor may tear the host out during the IndexedDB round trip: check isConnected first.
function _ceStoryImgRender(host, shortId, full, dataUrl, desc) {
    if (!host.isConnected) return;
    if (host.getAttribute && host.getAttribute('data-ce-storyimg') === full) return;
    host.setAttribute('data-ce-storyimg', full);
    _ceStoryImgClearWrap(host);
    host.className = (host.className || '') + ' ae-storyimg';

    var frame = document.createElement('div');
    frame.className = 'ae-storyimg-frame';

    var img = document.createElement('img');
    img.className = 'ae-storyimg-img';
    img.src = dataUrl;
    img.alt = desc || 'story image';
    img.addEventListener('click', function() { _galleryLightbox(dataUrl, (desc || '').slice(0, 120)); });
    frame.appendChild(img);

    frame.appendChild(_ceStoryImgCorner('tl', 'download', 'Download PNG', function() {
        _downloadAsPng(dataUrl, 'ae-' + String(full).slice(0, 8) + '.png');
    }));
    frame.appendChild(_ceStoryImgCorner('tr', 'pencil', 'Edit prompt / regenerate', function() {
        sendToEngine('AE_IMG_EDIT_OPEN', { uuid: full });
    }));
    frame.appendChild(_ceStoryImgCorner('br', 'trash', 'Delete image', function() {
        if (!confirm('Delete this image? It goes from the story and the gallery both, and cannot be undone.')) return;
        dbDelete(full).then(function() {
            imgCache.delete(full);
            _ccimgInvalidate();
            _ceSurfImgInvalidate();
            host.removeAttribute('data-ce-storyimg');
            _ceStoryImgClearWrap(host);
            sendToEngine('AE_STORY_IMG_DROP', { uuid: full });
            _showToast('Image deleted.');
        }).catch(function(e) { console.error('[CE:storyimg] delete failed:', e); });
    }));

    host.appendChild(frame);
    _ceStoryImgWrapMap.set(host, frame);
}

function _ceStoryImgPaintOne(node) {
    var raw = node.nodeValue || '';
    var shortId = raw.slice(AE_STORY_IMG_SENTINEL.length).trim().toLowerCase();
    if (!/^[0-9a-f]{8}$/.test(shortId)) return;

    var host = _ceStoryImgContainerFor(node);
    if (!host) return;
    var painted = host.getAttribute && host.getAttribute('data-ce-storyimg');
    if (painted && painted.indexOf('pending:') !== 0) return;

    _ceStoryImgBuildIndexSafe().then(function(idx) {
        var full = idx.get(shortId);
        if (!full) {
            _ceStoryImgPending(host, shortId);
            return null;
        }
        return _ccimgLoad(full).then(function(dataUrl) {
            if (!dataUrl) { _ceStoryImgPending(host, shortId); return null; }
            _ceStoryImgRender(host, shortId, full, dataUrl, _ceStoryImgDescFor(full));
            return null;
        });
    }).catch(function(e) { console.warn('[CE:storyimg] paint failed:', e); });
}

function _ceStoryImgBuildIndexSafe() {
    try { return _ccimgBuildIndex(); }
    catch (_e) { return Promise.resolve(new Map()); }
}

function _ceStoryImgDescFor(full) {
    var hit = imgCache.get(full);
    return (hit && (hit.prompt || hit.fp)) ? String(hit.prompt || hit.fp) : '';
}

function _ceStoryImgScan() {
    var nodes = _ceStoryImgFind();
    for (var i = 0; i < nodes.length; i++) _ceStoryImgPaintOne(nodes[i]);
    _ceStoryImgBubbleSweep(nodes);
    // [CR-STORYIMG-BUBBLE]
    if (_ceStoryImgBubbleTmr) clearTimeout(_ceStoryImgBubbleTmr);
    _ceStoryImgBubbleTmr = setTimeout(function() { _ceStoryImgBubbleTmr = null; _ceStoryImgBubbleSweep(null); }, 900);
}

// [CR-STORYIMG-BUBBLE]
// Marker restyles change attributes only and the observer watches childList, hence a second sweep.
var _ceStoryImgBubbleTmr = null;
var CE_STORYIMG_BUBBLE_PROPS = [
    'background-color', 'background-image',
    'border-top-width', 'border-top-style', 'border-top-color',
    'border-right-width', 'border-right-style', 'border-right-color',
    'border-bottom-width', 'border-bottom-style', 'border-bottom-color',
    'border-left-width', 'border-left-style', 'border-left-color',
    'border-top-left-radius', 'border-top-right-radius',
    'border-bottom-left-radius', 'border-bottom-right-radius',
    'box-shadow', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left'
];

function _ceStoryImgParagraphBefore(host) {
    var root = host.closest ? host.closest('.ProseMirror') : null;
    if (!root) return null;
    var row = host;
    var hops = 0;
    while (row && row.parentElement !== root && hops < 8) { row = row.parentElement; hops++; }
    if (!row || row.parentElement !== root) return null;
    var sib = row.previousElementSibling;
    var n = 0;
    while (sib && n < 6) {
        var widget = (sib.getAttribute && sib.getAttribute('contenteditable') === 'false')
            || (sib.querySelector && sib.querySelector('[data-ce-storyimg],[data-ce-ccav]'));
        if (!widget) return sib;
        sib = sib.previousElementSibling;
        n++;
    }
    return null;
}

function _ceStoryImgBubbleOne(host) {
    if (!host || !host.isConnected || !host.style) return;
    var para = _ceStoryImgParagraphBefore(host);
    var cs = null;
    try { cs = para ? window.getComputedStyle(para) : null; } catch (_e) { cs = null; }
    var styled = false;
    if (cs) {
        var bg = cs.getPropertyValue('background-color');
        var clear = !bg || bg === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(bg);
        styled = !clear || (cs.getPropertyValue('background-image') || 'none') !== 'none'
            || parseFloat(cs.getPropertyValue('border-left-width')) > 0
            || parseFloat(cs.getPropertyValue('border-top-width')) > 0;
    }
    var i;
    if (!styled) {
        if (host.getAttribute('data-cr-bubble')) {
            for (i = 0; i < CE_STORYIMG_BUBBLE_PROPS.length; i++) host.style.removeProperty(CE_STORYIMG_BUBBLE_PROPS[i]);
            host.removeAttribute('data-cr-bubble');
        }
        return;
    }
    var vals = [];
    for (i = 0; i < CE_STORYIMG_BUBBLE_PROPS.length; i++) vals.push(cs.getPropertyValue(CE_STORYIMG_BUBBLE_PROPS[i]));
    var key = vals.join('|');
    if (host.getAttribute('data-cr-bubble') === key) return;
    for (i = 0; i < CE_STORYIMG_BUBBLE_PROPS.length; i++) host.style.setProperty(CE_STORYIMG_BUBBLE_PROPS[i], vals[i]);
    host.setAttribute('data-cr-bubble', key);
}

function _ceStoryImgBubbleSweep(nodes) {
    var list = nodes || _ceStoryImgFind();
    for (var i = 0; i < list.length; i++) {
        try { _ceStoryImgBubbleOne(_ceStoryImgContainerFor(list[i])); }
        catch (e) { console.warn('[CE:storyimg] bubble copy failed:', e); }
    }
}

function _ceStoryImgNudge() {
    if (_ceStoryImgTmr) clearTimeout(_ceStoryImgTmr);
    _ceStoryImgTmr = setTimeout(function() { _ceStoryImgTmr = null; _ceStoryImgScan(); }, 400);
}

function _ceStoryImgStart() {
    if (_ceStoryImgObs) return;
    try {
        _ceStoryImgObs = new MutationObserver(_ceStoryImgNudge);
        _ceStoryImgObs.observe(document.body, { childList: true, subtree: true });
    } catch (e) {
        console.warn('[CE:storyimg] observer unavailable; story images will not repaint on edit:', e);
        _ceStoryImgObs = null;
    }
    _ceStoryImgNudge();
}

window.__ceStoryImgDiag = function() {
    var s = _ceStoryImgFind();
    var out = {
        sentinelsOnScreen: s.length,
        sentinelTexts: s.slice(0, 6).map(function(n) { return (n.nodeValue || '').slice(0, 40); }),
        observing: !!_ceStoryImgObs,
        indexSize: _ccimgIndex ? _ccimgIndex.size : 0
    };
    dbg('[CE:storyimg] diag', out);
    return out;
};

// Must match the engines' portrait sentinel.
var AE_CHARCHAT_AVA_SENTINEL = 'ce-chatava:';

function _ccavSettings() {
    var size = parseInt(localStorage.getItem('ae_ccav_size'), 10);
    if (!(size > 0)) size = 40;
    var radius = localStorage.getItem('ae_ccav_radius');
    if (radius !== 'round' && radius !== 'rounded' && radius !== 'portrait') radius = 'round';
    return { size: size, radius: radius };
}

function _ccavFindSentinels() {
    var out = [];
    var walker;
    try {
        walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
            acceptNode: function(n) {
                return (n.nodeValue && n.nodeValue.indexOf(AE_CHARCHAT_AVA_SENTINEL) === 0)
                    ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
            }
        });
    } catch (_e) { return out; }
    var n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
}

function _ccavContainerFor(textNode) {
    var el = textNode.parentElement;
    var best = el;
    var hops = 0;
    var ownLen = (textNode.nodeValue || '').trim().length;
    while (el && hops < 4) {
        if (el.hasAttribute && el.hasAttribute('data-ce-ccav')) return el;
        var t = (el.textContent || '').trim();
        if (t.indexOf(AE_CHARCHAT_AVA_SENTINEL) !== 0 || t.length > ownLen) break;
        best = el;
        el = el.parentElement;
        hops++;
    }
    return best;
}

window.__ceCcAvDiag = function() {
    var s = _ccavFindSentinels();
    var geo = s.slice(0, 6).map(function(n) {
        var host = _ccavContainerFor(n);
        var hr = host ? host.getBoundingClientRect() : null;
        var pr = (host && host.parentElement) ? host.parentElement.getBoundingClientRect() : null;
        return {
            text: (n.nodeValue || '').slice(0, 40),
            hostTag: host ? host.tagName : null,
            hostClass: host ? host.className : null,
            hostWidth: hr ? hr.width : null,
            hostLeft: hr ? hr.left : null,
            parentWidth: pr ? pr.width : null,
            parentLeft: pr ? pr.left : null
        };
    });
    var probe = s.slice(0, 4).map(function(n) {
        var o = _ccavParse(n.nodeValue);
        var key = o.emotion ? (o.id + '_em_' + o.emotion) : (o.id + '_em_' + AVATAR_SLOT_NAME);
        return _loadPortrait(key).then(function(direct) {
            return _loadPortrait(o.id + '_portrait').then(function(legacy) {
                return _portraitSlotsFor(o.id).then(function(slots) {
                    return { key: key, foundAtKey: !!direct, foundLegacy: !!legacy, slotsOnRecord: slots };
                }, function() { return { key: key, foundAtKey: !!direct, foundLegacy: !!legacy, slotsOnRecord: 'error' }; });
            });
        }, function(e) { return { key: key, error: String(e) }; });
    });
    Promise.all(probe).then(function(rows) {
        console.log('[CE:ccav] lookup probe', rows);
    });

    var out = {
        avatarSentinelsOnScreen: s.length,
        lookupProbe: 'logged separately above/below as [CE:ccav] lookup probe',
        painterWired: (typeof _ccavPaintOne === 'function') && !!_ccavObs,
        parsed: s.slice(0, 6).map(function(n) {
            var raw = (n.nodeValue || '').slice(AE_CHARCHAT_AVA_SENTINEL.length);
            var f = raw.split('|');
            return { contactId: f[0] || '', emotion: f[1] || '', extra: f.slice(2) };
        }),
        geometry: geo,
        settings: _ccavSettings()
    };
    dbg('[CE:ccav] diag', out);
    return out;
};

// SECTION 13d-2 — CHAT AVATAR PAINTER
var CCAV_MIN_PX = 16;
var CCAV_MAX_PX = 320;
var _ccavObs = null;
var _ccavTmr = null;

var CCAV_SHAPE_RADIUS = { round: '50%', rounded: '18%', portrait: '12%', square: '0' };

var _ccavWrapMap = new WeakMap();

var CCAV_PLACE_LEFT = {
    gutter: '0px',
    right: 'calc(89% - var(--ae-cca-size, 40px) / 2)'
};

// Remove only our own node: the host is the editor's and holds the sentinel.
function _ccavClearWrap(host) {
    var prev = _ccavWrapMap.get(host);
    if (prev && prev.parentNode === host) host.removeChild(prev);
    _ccavWrapMap.delete(host);
}

function _ccavParse(raw) {
    var body = String(raw || '').slice(AE_CHARCHAT_AVA_SENTINEL.length).trim();
    var f = body.split('|');
    var out = { id: (f[0] || '').trim(), emotion: (f[1] || '').trim(), size: 0, shape: '', place: '' };
    var rest = f.slice(2);
    for (var i = 0; i < rest.length; i++) {
        var seg = String(rest[i] || '').trim();
        if (!seg) continue;
        if (seg.indexOf('=') < 0) {
            if (/^\d+$/.test(seg)) { if (!out.size) out.size = parseInt(seg, 10); }
            else if (!out.shape) out.shape = seg;
            continue;
        }
        var toks = seg.split(',');
        for (var t = 0; t < toks.length; t++) {
            var kv = toks[t].split('=');
            if (kv.length !== 2) continue;
            var k = kv[0].trim(), v = kv[1].trim();
            if (k === 'size') out.size = parseInt(v, 10) || 0;
            else if (k === 'shape') out.shape = v;
            else if (k === 'place') out.place = v;
        }
    }
    return out;
}

function _ccavRender(host, key, opt, dataUrl) {
    if (!host.isConnected) return;
    if (host.getAttribute && host.getAttribute('data-ce-ccav') === key) return;
    host.setAttribute('data-ce-ccav', key);
    _ccavClearWrap(host);
    host.className = (host.className || '').replace(/\s*ae-ccav-anchor\b/g, '') + ' ae-ccav-anchor';

    var fallback = _ccavSettings();
    var px = opt.size || fallback.size;
    if (!(px > 0)) px = 40;
    if (px < CCAV_MIN_PX) px = CCAV_MIN_PX;
    if (px > CCAV_MAX_PX) px = CCAV_MAX_PX;
    var shape = opt.shape || fallback.radius;
    var radius = CCAV_SHAPE_RADIUS[shape] || CCAV_SHAPE_RADIUS.round;

    var img = document.createElement('img');
    img.className = 'ae-ccav';
    img.src = dataUrl;
    img.alt = '';
    img.style.setProperty('--ae-cca-size', String(px) + 'px');
    img.style.setProperty('--ae-cca-radius', radius);
    img.style.setProperty('--ae-cca-h-mult', shape === 'portrait' ? '1.333' : '1');
    img.style.setProperty('--ae-cc-avaleft', CCAV_PLACE_LEFT[opt.place] || CCAV_PLACE_LEFT.gutter);

    // [CR-CCAV-HOSTCLEAR] A beside-the-text portrait starts a message, so its box clears the one above.
    var clearBox = host;
    try {
        if (window.getComputedStyle(host).display === 'inline' && host.parentElement
            && !(host.parentElement.classList && host.parentElement.classList.contains('ProseMirror'))) {
            clearBox = host.parentElement;
        }
    } catch (_e) {}
    clearBox.style.clear = (opt.place === 'above' || opt.place === 'gutter') ? '' : 'both';

    if (opt.place === 'above') {
        img.style.position = 'static';
        img.style.left = 'auto';
        img.style.top = 'auto';
        img.style.display = 'block';
        img.style.margin = '0 0 4px 0';
        host.style.position = '';
        host.style.height = 'auto';
    }
    else if (opt.place === 'gutter') {
        img.style.position = 'absolute';
        img.style.cssFloat = 'none';
        img.style.left = '0';
        img.style.top = '0';
        img.style.display = 'block';
        img.style.margin = '2px 0 0 0';
        host.style.position = 'relative';
        host.style.height = '0';
    }
    else {
        img.style.position = 'static';
        img.style.left = 'auto';
        img.style.top = 'auto';
        img.style.display = 'block';
        img.style.cssFloat = 'left';
        img.style.margin = '2px 10px 2px 0';
        host.style.position = '';
        host.style.height = 'auto';
    }
    host.appendChild(img);
    _ccavWrapMap.set(host, img);
}

function _ccavPaintOne(node) {
    var opt = _ccavParse(node.nodeValue);
    if (!opt.id) return;
    var host = _ccavContainerFor(node);
    if (!host) return;

    var key = opt.id + '|' + opt.emotion + '|' + String(opt.size) + '|' + opt.shape + '|' + opt.place;
    if (host.getAttribute && host.getAttribute('data-ce-ccav') === key) return;

    _loadCharEmotionImage(opt.id, opt.emotion).then(function(dataUrl) {
        if (!dataUrl) return;
        _ccavRender(host, key, opt, dataUrl);
    }).catch(function(e) { console.warn('[CE:ccav] paint failed:', e); });
}

function _ccavScan() {
    var nodes = _ccavFindSentinels();
    for (var i = 0; i < nodes.length; i++) _ccavPaintOne(nodes[i]);
}

function _ccavNudge() {
    if (_ccavTmr) clearTimeout(_ccavTmr);
    _ccavTmr = setTimeout(function() { _ccavTmr = null; _ccavScan(); }, 400);
}

function _ccavStart() {
    if (_ccavObs) return;
    try {
        _ccavObs = new MutationObserver(_ccavNudge);
        _ccavObs.observe(document.body, { childList: true, subtree: true });
    } catch (e) {
        console.warn('[CE:ccav] observer unavailable; avatars will not repaint on edit:', e);
        _ccavObs = null;
    }
    _ccavNudge();
}

// SECTION 13e — CE SURFACE IMAGE PAINTER

var CE_IMG_ATTR  = 'data-ce-img';
var CE_IMG_PAINT = 'data-ce-img-key';

var CE_IMG_GAL   = 'ce-gallery';

var _ceSurfImgRoots   = [];
var _ceSurfImgRootsTs = 0;
var _ceSurfImgTmr     = null;
var _ceSurfImgEpoch   = 1;

function _ceSurfImgInvalidate() { _ceSurfImgEpoch = _ceSurfImgEpoch + 1; }

function _ceSurfImgCollect(node, out, depth) {
    if (!node || depth > 6) return;
    var els;
    try { els = node.querySelectorAll('*'); } catch (_e) { return; }
    for (var i = 0; i < els.length; i++) {
        var sr = els[i].shadowRoot;
        if (!sr) continue;
        out.push(sr);
        _ceSurfImgCollect(sr, out, depth + 1);
    }
}

function _ceSurfImgRootList() {
    var now = Date.now();
    var live = [];
    for (var i = 0; i < _ceSurfImgRoots.length; i++) {
        var r = _ceSurfImgRoots[i];
        if (r && r.host && r.host.isConnected) live.push(r);
    }
    if (live.length && (now - _ceSurfImgRootsTs) < 4000) { _ceSurfImgRoots = live; return live; }
    var found = [];
    if (document.body) _ceSurfImgCollect(document.body, found, 0);
    _ceSurfImgRoots = found; _ceSurfImgRootsTs = now;
    return found;
}

function _ceSurfImgEnsureStyle(root) {
    try {
        if (root.querySelector('style[data-ce-surf-style]')) return;
        var st = document.createElement('style');
        st.setAttribute('data-ce-surf-style', '1');
        st.textContent =
            '[' + CE_IMG_ATTR + ']{position:relative;overflow:hidden;}' +
            '.ce-surf-img{position:absolute;left:0;top:0;width:100%;height:100%;' +
            'object-fit:cover;display:block;border-radius:inherit;z-index:1;}' +
            '.ce-surf-empty{display:none !important;}' +
            '.ce-surf-shrink{width:auto !important;height:auto !important;' +
            'min-width:0 !important;min-height:0 !important;padding:0 !important;' +
            'border:none !important;background:none !important;border-radius:0 !important;}';
        root.appendChild(st);
    } catch (_e) {}
}

function _ceSurfImgResolve(charId, slot, wantThumb) {
    if (!charId) return Promise.resolve(null);
    if (charId === CE_IMG_GAL) {
        if (!slot) return Promise.resolve(null);
        return dbGet(slot).then(function(rec) {
            if (!rec) return null;
            if (!wantThumb) return rec.dataUrl || null;
            if (rec.thumb) return rec.thumb;
            if (rec.thumb === null && Object.prototype.hasOwnProperty.call(rec, 'thumb')) {
                return rec.dataUrl || null;
            }
            var full = rec.dataUrl || null;
            if (!full) return null;
            return _ceMakeThumb(full).then(function(t) {
                dbStampField(slot, 'thumb', t);
                return t || full;
            }).catch(function() { return full; });
        });
    }
    if (!slot || slot === AVATAR_SLOT_NAME) return _loadCharAvatarImage(charId);
    return _loadPortrait(charId + '_em_' + slot).catch(function() { return null; });
}

function _ceSurfImgParse(payload) {
    var parts = String(payload || '').split('|');
    var opts = {};
    var raw = String(parts[2] || '').split(',');
    for (var i = 0; i < raw.length; i++) {
        var kv = raw[i].split('=');
        var k = String(kv[0] || '').trim();
        if (!k) continue;
        opts[k] = (kv.length > 1) ? String(kv[1] || '').trim() : '1';
    }
    return { charId: String(parts[0] || '').trim(), slot: String(parts[1] || '').trim(), opts: opts };
}

function _ceSurfImgFace(el, face) {
    if (face !== 'right' && face !== 'left') return;
    var img = el.querySelector('.ce-surf-img');
    if (!img) return;
    var p = el.parentNode;
    if (!p || !p.children) return;
    var sibs = p.children, n = 0, idx = -1, i;
    for (i = 0; i < sibs.length; i++) {
        var s = sibs[i];
        if (!s.hasAttribute || !s.hasAttribute(CE_IMG_ATTR)) continue;
        if (s.classList && s.classList.contains('ce-surf-empty')) continue;
        if (s === el) idx = n;
        n++;
    }
    var mirror = false;
    if (idx >= 0 && n > 1) {
        var half = (idx * 2) + 1;
        if (half > n) mirror = (face === 'right');
        else if (half < n) mirror = (face === 'left');
    }
    var want = mirror ? 'scaleX(-1)' : '';
    if (img.style.transform !== want) img.style.transform = want;
}

// [CR-IMGAR]
var CE_AR_HOST = 'data-ce-ar-host';
var CE_AR_PROP = '--ce-img-ar';
// [CR-IMGAR]
var CE_AR_SEEN = 'data-ce-ar';

function _ceSurfImgPublishRatio(el, w, h) {
    if (!w || !h) return;
    var want = String(w) + ' / ' + String(h);
    var node = el.parentNode;
    for (var i = 0; i < 4 && node && node.nodeType === 1; i++) {
        if (node.hasAttribute && node.hasAttribute(CE_AR_HOST)) {
            if (node.style.getPropertyValue(CE_AR_PROP).trim() !== want) {
                node.style.setProperty(CE_AR_PROP, want);
            }
            try { el.setAttribute(CE_AR_SEEN, want); } catch (_eSeen) {}
            return;
        }
        node = node.parentNode;
    }
}

function _crArRepublish(el) {
    var seen = el.getAttribute(CE_AR_SEEN);
    if (!seen) return;
    var node = el.parentNode;
    for (var i = 0; i < 4 && node && node.nodeType === 1; i++) {
        if (node.hasAttribute && node.hasAttribute(CE_AR_HOST)) {
            if (node.style.getPropertyValue(CE_AR_PROP).trim() !== seen) {
                node.style.setProperty(CE_AR_PROP, seen);
            }
            return;
        }
        node = node.parentNode;
    }
}

function _ceSurfImgPaintOne(el) {
    var payload = el.getAttribute(CE_IMG_ATTR) || '';
    var a = _ceSurfImgParse(payload);
    var charId = a.charId;
    var slot = a.slot;
    if (!charId) return;

    var key = _ceSurfImgEpoch + '|' + charId + '|' + slot;
    try { _ceSurfImgFace(el, a.opts.face); } catch (_eFace) {}
    // [CR-IMGAR]
    try { _crArRepublish(el); } catch (_eAr0) {}
    if (el.getAttribute(CE_IMG_PAINT) === key) return;

    _ceSurfImgResolve(charId, slot, a.opts.thumb === '1').then(function(dataUrl) {
        if (!el.isConnected) return;
        el.setAttribute(CE_IMG_PAINT, key);
        var old = el.querySelector('.ce-surf-img');
        if (old && old.parentNode === el) el.removeChild(old);
        if (!dataUrl) {
            try {
                if (a.opts.collapse === '1') el.classList.add('ce-surf-empty');
                if (a.opts.shrink === '1') el.classList.add('ce-surf-shrink');
            } catch (_e1) {}
            return;
        }
        try { el.classList.remove('ce-surf-empty'); el.classList.remove('ce-surf-shrink'); } catch (_e2) {}
        var img = document.createElement('img');
        img.className = 'ce-surf-img';
        img.src = dataUrl;
        img.alt = slot || 'image';
        if (a.opts.fit === 'contain') img.style.objectFit = 'contain';
        if (a.opts.pos === 'bottom') img.style.objectPosition = '50% 100%';
        img.style.pointerEvents = 'none';
        // [CR-IMGAR]
        img.addEventListener('load', function() {
            try { _ceSurfImgPublishRatio(el, img.naturalWidth, img.naturalHeight); } catch (_eAr) {}
        });
        el.appendChild(img);
        if (img.complete && img.naturalWidth) {
            try { _ceSurfImgPublishRatio(el, img.naturalWidth, img.naturalHeight); } catch (_eAr2) {}
        }
        try { _ceSurfImgFace(el, a.opts.face); } catch (_eFace2) {}
    }).catch(function(e) { dbg('[CE:surfimg] paint failed', e); });
}

function _ceSurfImgSweep(root) {
    var stale;
    try { stale = root.querySelectorAll('[' + CE_IMG_PAINT + ']'); } catch (_e) { return; }
    for (var i = 0; i < stale.length; i++) {
        var el = stale[i];
        if (el.hasAttribute(CE_IMG_ATTR)) continue;
        try {
            var img = el.querySelector('.ce-surf-img');
            if (img && img.parentNode === el) el.removeChild(img);
            el.removeAttribute(CE_IMG_PAINT);
            el.classList.remove('ce-surf-empty');
            el.classList.remove('ce-surf-shrink');
        } catch (_e2) {}
    }
}

var _ceSurfImgObsMark = '__ceSurfImgObserved';
var _ceSurfImgRaf     = 0;

function _ceSurfImgSchedule() {
    if (_ceSurfImgRaf) return;
    var run = function() { _ceSurfImgRaf = 0; try { _ceSurfImgScan(); } catch (_e) {} };
    try { _ceSurfImgRaf = window.requestAnimationFrame(run); }
    catch (_e2) { _ceSurfImgRaf = setTimeout(run, 16); }
}

function _ceSurfImgOnMutate() {
    var roots = _ceSurfImgRoots;
    for (var i = 0; i < roots.length; i++) {
        if (roots[i] && roots[i].host && roots[i].host.isConnected) {
            try { _ceSurfImgSweep(roots[i]); } catch (_e) {}
        }
    }
    _ceSurfImgSchedule();
}

function _ceSurfImgObserve(root) {
    try {
        if (!root || root[_ceSurfImgObsMark]) return;
        if (typeof MutationObserver !== 'function') return;
        var mo = new MutationObserver(_ceSurfImgOnMutate);
        mo.observe(root, { childList: true, subtree: true, attributes: true });
        root[_ceSurfImgObsMark] = mo;
    } catch (_e) {}
}

function _ceSurfImgStart() {
    if (_ceSurfImgTmr) return;
    _ceSurfImgTmr = setInterval(_ceSurfImgScan, 700);
    try { _ceSurfImgScan(); } catch (_e) {}
}

function _ceSurfImgScan() {
    if (!document.body) return;
    var roots = _ceSurfImgRootList();
    for (var i = 0; i < roots.length; i++) {
        _ceSurfImgObserve(roots[i]);
        var els;
        try { els = roots[i].querySelectorAll('[' + CE_IMG_ATTR + ']'); } catch (_e) { continue; }
        _ceSurfImgSweep(roots[i]);
        if (!els.length) continue;
        _ceSurfImgEnsureStyle(roots[i]);
        for (var j = 0; j < els.length; j++) _ceSurfImgPaintOne(els[j]);
    }
}

window.__ceSurfImgDiag = function() {
    var roots = _ceSurfImgRootList();
    var anchors = [];
    for (var i = 0; i < roots.length; i++) {
        var els;
        try { els = roots[i].querySelectorAll('[' + CE_IMG_ATTR + ']'); } catch (_e) { continue; }
        for (var j = 0; j < els.length; j++) {
            anchors.push({
                payload: els[j].getAttribute(CE_IMG_ATTR),
                parsed: _ceSurfImgParse(els[j].getAttribute(CE_IMG_ATTR)),
                painted: els[j].getAttribute(CE_IMG_PAINT),
                hasImg: !!els[j].querySelector('.ce-surf-img'),
                collapsed: els[j].classList.contains('ce-surf-empty'),
                w: Math.round(els[j].getBoundingClientRect().width),
                h: Math.round(els[j].getBoundingClientRect().height)
            });
        }
    }
    var stranded = 0;
    for (var s = 0; s < roots.length; s++) {
        var mk;
        try { mk = roots[s].querySelectorAll('[' + CE_IMG_PAINT + ']'); } catch (_e3) { continue; }
        for (var t = 0; t < mk.length; t++) { if (!mk[t].hasAttribute(CE_IMG_ATTR)) stranded++; }
    }
    var observed = 0;
    for (var o = 0; o < roots.length; o++) { if (roots[o] && roots[o][_ceSurfImgObsMark]) observed++; }
    var out = { shadowRoots: roots.length, observed: observed, anchors: anchors, epoch: _ceSurfImgEpoch,
                stranded: stranded, scannerRunning: !!_ceSurfImgTmr };
    dbg('[CE:surfimg] diag', out);
    return out;
};

// SECTION 17 — UTILITY HELPERS

var CE_IMG_CSS = [
'html{--ae-bg-border:rgba(255,255,255,0.14);--ae-bg-raised:rgba(255,255,255,0.05);',
'  --ae-text-main:#e9e9ec;--ae-text-dim:rgba(233,233,236,0.62);--ae-accent:#4a9ed9;',
'  --ae-accent-text:#e8c07d;--ae-radius-md:8px;--ae-shadow-sm:0 2px 8px rgba(0,0,0,0.35);',
'  --ae-font-size-xs:11px;',
'  --ae-font-sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;',
'  --ae-font-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;',
'  --ae-chat-marker:#e8a04a;--ae-chat-radius:16px;',
'  --ae-chat-pov-bg:rgba(74,158,217,0.16);--ae-chat-pov-border:rgba(74,158,217,0.42);',
'  --ae-chat-them-bg:rgba(255,255,255,0.055);--ae-chat-them-border:rgba(255,255,255,0.14);}',
'.ae-ccimg{display:block;width:auto;margin:0;max-width:var(--ae-cc-max,78%);',
'  padding:2px calc(var(--ae-cc-padx,12px) + var(--ae-cc-lane,0px)) 8px var(--ae-cc-padx,12px);',
'  background:var(--ae-cc-them-bg,transparent);',
'  border:var(--ae-cc-them-edge,none);border-top:none;border-bottom:none;border-radius:0;}',
'.ae-ccimg.pov{margin-left:auto;margin-right:0;',
'  padding-right:var(--ae-cc-padx,12px);',
'  background:var(--ae-cc-pov-bg,transparent);',
'  border:var(--ae-cc-pov-edge,none);border-top:none;',
'  border-radius:0 0 var(--ae-cc-notch,5px) var(--ae-cc-radius,16px);}',
'.ae-ccimg-frame{position:relative;border:none;border-radius:var(--ae-radius-md);',
'  overflow:hidden;background:transparent;box-shadow:none;width:100%;max-width:var(--ae-ccimg-max,100%);}',
'.ae-ccimg-img{width:100%;height:auto;display:block;cursor:pointer;}',
'.ae-ccimg-frame:focus-within{outline:1px solid var(--ae-cc-accent,var(--ae-accent));outline-offset:2px;}',
'.ae-ccimg-pend{padding:18px 12px;text-align:center;font-size:var(--ae-font-size-xs);',
'  color:var(--ae-cc-them-ink,var(--ae-text-dim));font-family:var(--ae-cc-font,inherit);}',
'.ae-ccimg.pov .ae-ccimg-pend{color:var(--ae-cc-pov-ink,var(--ae-text-dim));}',
'.ae-ccimg-corner,.ae-storyimg-corner{position:absolute;width:24px;height:24px;padding:0;display:flex;',
'  align-items:center;justify-content:center;border:none;border-radius:6px;background:rgba(12,12,16,0.62);',
'  color:var(--ae-text-main);cursor:pointer;opacity:0;transition:opacity 140ms ease,background 140ms ease;z-index:3;}',
'.ae-ccimg-frame:hover .ae-ccimg-corner,.ae-storyimg-frame:hover .ae-storyimg-corner{opacity:0.85;}',
'.ae-ccimg-corner:hover,.ae-storyimg-corner:hover{opacity:1;background:rgba(12,12,16,0.82);color:var(--ae-accent-text);}',
'.ae-ccimg-corner:focus-visible,.ae-storyimg-corner:focus-visible{opacity:1;outline:2px solid var(--ae-accent);outline-offset:1px;}',
'.ae-ccimg-corner.tl,.ae-storyimg-corner.tl{top:6px;left:6px;}',
'.ae-ccimg-corner.br,.ae-storyimg-corner.br{bottom:6px;right:6px;}',
'.ae-ccimg-corner.tr,.ae-storyimg-corner.tr{top:6px;right:6px;}',
'@media (hover:none){.ae-ccimg-corner,.ae-storyimg-corner{opacity:0.72;}}',
'.ae-storyimg{display:block;margin:10px 0 12px;}',
'.ae-storyimg-frame{position:relative;display:block;width:fit-content;max-width:100%;',
'  border:1px solid var(--ae-bg-border);border-radius:var(--ae-radius-md);overflow:hidden;',
'  background:var(--ae-bg-raised);box-shadow:var(--ae-shadow-sm);}',
'.ae-storyimg-img{display:block;max-width:100%;width:auto;height:auto;cursor:pointer;}',
'.ae-storyimg-pendframe{width:100%;max-width:320px;}',
'.ae-storyimg-pend{display:flex;align-items:center;justify-content:center;gap:8px;',
'  padding:18px 12px;font-size:var(--ae-font-size-xs);color:var(--ae-text-dim);}',
'.ae-storyimg-spin{width:12px;height:12px;flex:0 0 auto;border-radius:50%;',
'  border:2px solid var(--ae-bg-border);border-top-color:var(--ae-accent-text);',
'  animation:ae-storyimg-spin 0.9s linear infinite;}',
'@keyframes ae-storyimg-spin{to{transform:rotate(360deg);}}',
'@media (prefers-reduced-motion:reduce){.ae-storyimg-spin{animation:none;}}',
'.ae-lightbox{position:fixed;inset:0;z-index:9999999;display:flex;flex-direction:column;',
'  align-items:center;justify-content:center;gap:8px;padding:24px;box-sizing:border-box;',
'  background:rgba(0,0,0,0.82);cursor:zoom-out;overscroll-behavior:contain;}',
'.ae-lightbox img{max-width:100%;max-height:calc(100vh - 96px);width:auto;height:auto;',
'  object-fit:contain;display:block;border-radius:8px;cursor:default;',
'  box-shadow:0 8px 40px rgba(0,0,0,0.6);}',
'.ae-lightbox p{margin:0;}',
'.ae-ccav-anchor{position:relative;height:0;overflow:visible;display:block;width:100%;}',
'.ae-ccav{position:absolute;left:var(--ae-cc-avaleft,calc(89% - var(--ae-cca-size,40px) / 2));top:6px;',
'  width:var(--ae-cca-size,40px);height:calc(var(--ae-cca-size,40px) * var(--ae-cca-h-mult,1));',
'  border-radius:var(--ae-cca-radius,50%);object-fit:cover;border:1px solid var(--ae-bg-border);',
'  background:var(--ae-bg-raised);box-shadow:var(--ae-shadow-sm);}',
'.ae-ccctl-anchor{position:relative;height:0;overflow:visible;display:block;width:100%;}',
'.ae-ccctl{position:absolute;left:var(--ae-cc-avaleft,calc(89% - var(--ae-cca-size,40px) / 2));top:6px;',
'  width:calc(var(--ae-cca-size,40px) + 22px);',
'  height:calc(var(--ae-cca-size,40px) * var(--ae-cca-h-mult,1) + 22px);',
'  pointer-events:none;z-index:2;opacity:0.34;transition:opacity 140ms ease;}',
'.ae-ccctl-btn{pointer-events:auto;position:absolute;}',
'.ae-ccctl-d{top:0;right:0;}',
'.ae-ccctl-e{bottom:0;left:0;}',
'.ae-ccctl-r{bottom:0;right:0;}',
'.ae-ccctl:hover,.ae-ccctl:focus-within{opacity:1;}',
'.ae-ccav-anchor:hover .ae-ccctl,.ae-ccctl-anchor:hover .ae-ccctl{opacity:1;}',
'.ae-ccctl-btn{width:22px;height:22px;padding:0;display:flex;align-items:center;',
'  justify-content:center;border:1px solid var(--ae-bg-border);border-radius:6px;',
'  background:rgba(12,12,16,0.72);color:var(--ae-text-dim);cursor:pointer;',
'  font:inherit;line-height:0;transition:color 140ms ease,background 140ms ease,',
'  border-color 140ms ease;}',
'.ae-ccctl-btn:hover{background:rgba(12,12,16,0.9);color:var(--ae-accent-text);',
'  border-color:var(--ae-accent-text);}',
'.ae-ccctl-btn:focus-visible{outline:2px solid var(--ae-accent);outline-offset:1px;',
'  color:var(--ae-text-main);}',
'.ae-ccctl-btn svg{display:block;}',
'.ae-ccctl-danger:hover{color:#e8776a;border-color:#e8776a;}',
'@media (hover:none){.ae-ccctl{opacity:0.7;}}',
'@media (prefers-reduced-motion:reduce){.ae-ccctl,.ae-ccctl-btn{transition:none;}}'
].join('');

var CE_MINI_ICON_PATHS = {
    download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'],
    trash: ['M3 6h18', 'M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2', 'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6']
    ,pencil: ['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z']
};
function _ceMiniIcon(name, size) {
    var ds = CE_MINI_ICON_PATHS[name];
    if (!ds) return null;
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', String(size || 14));
    svg.setAttribute('height', String(size || 14));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.7');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < ds.length; i++) {
        var p = document.createElementNS(NS, 'path');
        p.setAttribute('d', ds[i]);
        svg.appendChild(p);
    }
    return svg;
}

function initUI() {
    try {
        if (!document.getElementById('ae-ce-imgwidget-css')) {
            var _st = document.createElement('style');
            _st.id = 'ae-ce-imgwidget-css';
            _st.textContent = CE_IMG_CSS;
            document.head.appendChild(_st);
        }
    } catch (_ecss) { console.error('[CE Bridge] widget css inject failed:', _ecss); }

    try { _ceStoryImgStart(); } catch (_esi) { console.error('[CE Bridge] story image observer failed:', _esi); }
    try { _ccavStart(); } catch (_eav) { console.error('[CE Bridge] chat avatar observer failed:', _eav); }
    try { _ceSurfImgStart(); } catch (_esu) { console.error('[CE Bridge] surface image scanner failed:', _esu); }

    loadCachedImgFields();

    (function registerBridgeListener(attempt) {
        var bridge = window.NAITMBridge;
        if (bridge) {
            if (_bridgeUnsubscribe) { _bridgeUnsubscribe(); _bridgeUnsubscribe = null; }
            _bridgeUnsubscribe = bridge.on(function(payload, meta) { handleEngineMessage(payload, meta); });
            console.log('[CE Bridge] NAITMBridge listener registered (attempt ' + attempt + ').');
        } else {
            console.warn('[CE Bridge] NAITMBridge not ready on attempt ' + attempt + '. Retrying in 1s.');
            if (attempt < 5) setTimeout(function() { registerBridgeListener(attempt + 1); }, 1000);
            else console.error('[CE Bridge] NAITMBridge never became available. Bridge disabled.');
        }
    })(1);

    _ceViewportWatch();
}

function _ceImgForceRepaint(full) {
    var short = String(full || '').replace(/-/g, '').substring(0, 8).toLowerCase();
    imgCache.delete(full);
    _ccimgInvalidate();
    _ceSurfImgInvalidate();
    try {
        var chat = document.querySelectorAll('[data-ce-ccimg="' + short + '"]');
        for (var i = 0; i < chat.length; i++) {
            chat[i].removeAttribute('data-ce-ccimg');
            var w = _ccimgWrapMap.get(chat[i]);
            if (w && w.parentNode === chat[i]) chat[i].removeChild(w);
            _ccimgWrapMap.delete(chat[i]);
        }
        var story = document.querySelectorAll('[data-ce-storyimg="' + full + '"]');
        for (var j = 0; j < story.length; j++) {
            story[j].removeAttribute('data-ce-storyimg');
            _ceStoryImgClearWrap(story[j]);
        }
    } catch (e) { console.warn('[CE Bridge] repaint sweep failed:', e); }
    try { _ceStoryImgNudge(); } catch (e2) {}
    try { _ccavNudge(); } catch (e3) {}
}

function _ceGallerySendIndex() {
    var out = [];
    dbEachRecord(function(r) {
        if (!r || !r.uuid) return;
        out.push({ uuid: String(r.uuid), prompt: String(r.prompt || ''),
                   storyId: String(r.storyId || ''), createdAt: Number(r.ts) || 0,
                   hasBytes: !!r.dataUrl });
    }).then(function() {
        out.sort(function(a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
        sendToEngine('AE_GALLERY_INDEX_RESP', { images: out, storyId: activeStoryId || '' });
    }).catch(function(e) {
        console.error('[AE Bridge] gallery index failed:', e);
        sendToEngine('AE_GALLERY_INDEX_RESP', { images: [], storyId: activeStoryId || '' });
    });
}

var _ceZipCrcTable = null;
function _ceZipCrc32(buf) {
    var t = _ceZipCrcTable;
    if (!t) {
        t = new Int32Array(256);
        for (var n = 0; n < 256; n++) {
            var c = n;
            for (var k = 0; k < 8; k++) { c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); }
            t[n] = c;
        }
        _ceZipCrcTable = t;
    }
    var crc = -1;
    for (var i = 0; i < buf.length; i++) { crc = (crc >>> 8) ^ t[(crc ^ buf[i]) & 0xFF]; }
    return (crc ^ -1) >>> 0;
}

function _ceZipBytes(str) {
    var out = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) { out[i] = str.charCodeAt(i) & 0xFF; }
    return out;
}
function _ceZipHeader(sig, fields) {
    var out = new Uint8Array(sig.length);
    out.set(sig);
    var parts = [out];
    for (var i = 0; i < fields.length; i++) {
        var w = fields[i][0], v = fields[i][1] >>> 0, b = new Uint8Array(w);
        for (var j = 0; j < w; j++) { b[j] = (v >>> (8 * j)) & 0xFF; }
        parts.push(b);
    }
    var total = 0, k;
    for (k = 0; k < parts.length; k++) total += parts[k].length;
    var res = new Uint8Array(total), off = 0;
    for (k = 0; k < parts.length; k++) { res.set(parts[k], off); off += parts[k].length; }
    return res;
}

function _ceDataUrlBytes(dataUrl) {
    try {
        if (typeof dataUrl !== 'string') return null;
        var comma = dataUrl.indexOf(',');
        if (dataUrl.indexOf('data:') !== 0 || comma < 0) return null;
        var head = dataUrl.slice(5, comma);
        if (head.indexOf('base64') < 0) return null;
        var mime = head.split(';')[0] || '';
        var bin = atob(dataUrl.slice(comma + 1));
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) { bytes[i] = bin.charCodeAt(i) & 0xFF; }
        var ext = 'bin';
        if (mime === 'image/png') ext = 'png';
        else if (mime === 'image/webp') ext = 'webp';
        else if (mime === 'image/jpeg') ext = 'jpg';
        return { bytes: bytes, ext: ext };
    } catch (_e) { return null; }
}

function _ceZipSafeName(s) {
    return String(s || '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
}

function _ceGalleryExportAll() {
    var parts = [];
    var central = [];
    var offset = 0;
    var count = 0;
    var manifest = ['uuid\tfile\tcreated\tstoryId\tprompt'];

    function addEntry(name, bytes) {
        var nameBytes = _ceZipBytes(name);
        var crc = _ceZipCrc32(bytes);
        var local = _ceZipHeader([0x50, 0x4B, 0x03, 0x04], [
            [2, 20], [2, 0], [2, 0], [2, 0], [2, 0],
            [4, crc], [4, bytes.length], [4, bytes.length],
            [2, nameBytes.length], [2, 0]
        ]);
        parts.push(local, nameBytes, bytes);
        central.push({ name: nameBytes, crc: crc, size: bytes.length, off: offset });
        offset += local.length + nameBytes.length + bytes.length;
        count++;
    }

    _showToast('Packing the gallery\u2026');
    dbEachRecord(function(r) {
        if (!r || !r.uuid) return;
        var got = _ceDataUrlBytes(r.dataUrl);
        if (!got) return;
        var fname = 'images/ae-' + _ceZipSafeName(r.uuid) + '.' + got.ext;
        addEntry(fname, got.bytes);
        var when = '';
        try { when = r.ts ? new Date(Number(r.ts)).toISOString() : ''; } catch (_d) { when = ''; }
        manifest.push(String(r.uuid) + '\t' + fname + '\t' + when + '\t'
            + String(r.storyId || '') + '\t'
            + String(r.prompt || '').replace(/[\t\r\n]+/g, ' '));
    }).then(function() {
        if (!count) { _showToast('Nothing in the gallery to export.'); return; }
        addEntry('manifest.tsv', _ceZipBytes(unescape(encodeURIComponent(manifest.join('\n')))));
        var cdStart = offset, cdSize = 0, i;
        for (i = 0; i < central.length; i++) {
            var c = central[i];
            var hdr = _ceZipHeader([0x50, 0x4B, 0x01, 0x02], [
                [2, 20], [2, 20], [2, 0], [2, 0], [2, 0], [2, 0],
                [4, c.crc], [4, c.size], [4, c.size],
                [2, c.name.length], [2, 0], [2, 0], [2, 0], [2, 0], [4, 0], [4, c.off]
            ]);
            parts.push(hdr, c.name);
            cdSize += hdr.length + c.name.length;
        }
        parts.push(_ceZipHeader([0x50, 0x4B, 0x05, 0x06], [
            [2, 0], [2, 0], [2, central.length], [2, central.length],
            [4, cdSize], [4, cdStart], [2, 0]
        ]));
        try {
            var blob = new Blob(parts, { type: 'application/zip' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            var stamp = new Date().toISOString().slice(0, 10);
            a.href = url; a.download = 'ce-gallery-' + stamp + '.zip';
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            setTimeout(function() { try { URL.revokeObjectURL(url); } catch (_r) {} }, 60000);
            _showToast(count + ' image' + (count === 1 ? '' : 's') + ' exported.');
        } catch (e) {
            console.error('[CE Bridge] gallery export failed:', e);
            _showToast('Export failed \u2014 nothing was deleted.');
        }
    }).catch(function(e) {
        console.error('[CE Bridge] gallery export failed:', e);
        _showToast('Export failed \u2014 nothing was deleted.');
    });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUI);
else initUI();

function _ceGhostRoots() {
    var out = [document];
    if (document.body) _ceSurfImgCollect(document.body, out, 0);
    return out;
}

function _ceGhostChain(el, levels) {
    var chain = [];
    var cur = el;
    for (var i = 0; i < levels && cur; i++) {
        var p = cur.parentElement;
        if (!p) {
            var rt = cur.getRootNode ? cur.getRootNode() : null;
            p = (rt && rt.host) ? rt.host : null;
            if (p) chain.push('(shadow boundary)');
        }
        if (!p) break;
        var cls = '';
        try { cls = p.className ? ('.' + String(p.className).split(/\s+/).slice(0, 2).join('.')) : ''; } catch (_e) {}
        chain.push(p.tagName + cls + ' kids=' + p.children.length);
        cur = p;
    }
    return chain;
}

function _ceGhostRect(el) {
    try {
        var r = el.getBoundingClientRect();
        return Math.round(r.width) + 'x' + Math.round(r.height) + ' @' + Math.round(r.left) + ',' + Math.round(r.top);
    } catch (_e) { return '?'; }
}

function _ceGhostProbe(outline) {
    var roots = _ceGhostRoots();
    var navRows = [];
    var backs = [];
    for (var i = 0; i < roots.length; i++) {
        var els;
        try { els = roots[i].querySelectorAll('*'); } catch (_e) { continue; }
        for (var j = 0; j < els.length; j++) {
            var el = els[j];
            var txt = '';
            try { txt = (el.textContent || '').replace(/\s+/g, ' ').trim(); } catch (_e2) { continue; }
            if (el.children.length >= 6 && el.children.length <= 8
                && txt.indexOf('Map') === 0 && txt.indexOf('Wizard') > 0) {
                navRows.push(el);
            }
            if (txt.charAt(0) === '\u2190' && txt.length < 40) backs.push(el);
        }
    }
    var dumped = 0;
    var dump = function(node, depth) {
        if (!node || dumped > 300 || depth > 12) return;
        var kids = node.children || [];
        for (var d = 0; d < kids.length; d++) {
            var k = kids[d];
            dumped++;
            if (dumped > 300) { console.log('   ... truncated at 300 nodes'); return; }
            var t = '';
            try { t = (k.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30); } catch (_eD) {}
            var h = '?';
            try { h = Math.round(k.getBoundingClientRect().height); } catch (_eD2) {}
            console.log(new Array(depth + 2).join('  ') + k.tagName + ' kids=' + kids.length
                + ' h=' + h + (t ? ' "' + t + '"' : ''));
            dump(k, depth + 1);
        }
    };
    console.log('[CE ghost] roots scanned:', roots.length);
    for (var r = 1; r < roots.length; r++) {
        console.log('[CE ghost] --- shadow root ' + r + ' subtree ---');
        dump(roots[r], 0);
    }
    console.log('[CE ghost] nav rows found:', navRows.length, '(1 is correct)');
    for (var n = 0; n < navRows.length; n++) {
        console.log('   nav[' + n + '] ' + _ceGhostRect(navRows[n]) + '  up: ' + _ceGhostChain(navRows[n], 4).join(' < '));
    }
    console.log('[CE ghost] back buttons found:', backs.length, '(1 inside a submenu, 0 otherwise)');
    for (var b = 0; b < backs.length; b++) {
        var t = '';
        try { t = (backs[b].textContent || '').trim().slice(0, 30); } catch (_e3) {}
        console.log('   back[' + b + '] "' + t + '" ' + _ceGhostRect(backs[b])
            + '  up: ' + _ceGhostChain(backs[b], 5).join(' < '));
        if (outline !== false) {
            try { backs[b].style.outline = (b === backs.length - 1) ? '2px solid lime' : '2px solid red'; } catch (_e4) {}
        }
    }
    if (outline !== false) console.log('[CE ghost] outlined: LAST found is lime, the rest red. Tap the lime one — if it works, the reds are the corpses.');
    return { roots: roots.length, navRows: navRows, backs: backs };
}

window.aeBridge = {
    status: function() {
        console.log('Engine:', engineScriptId, '(' + engineKind + ')', '| Story:', activeStoryId, '| Cached images:', imgCache.size);
    },
    sendToEngine: sendToEngine,
    slots: _portraitSlotsFor,
    gallery: _ceGallerySendIndex,
    exportGallery: _ceGalleryExportAll,
    ghost: _ceGhostProbe
};

})();
