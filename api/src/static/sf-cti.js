/**
 * sf-cti.js — Vici2 Open CTI Adapter
 * Served from: https://api.vici2.example.com/static/sf-cti.js
 *
 * Execution context: Salesforce Lightning softphone panel iframe.
 * No bundler — vanilla ES2020 (supported by all modern browsers).
 * No external dependencies beyond opencti_min.js (injected from SF instance).
 * Minimum SF API version: v55+
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 1. Configuration: read tenant slug and web origin from query params
  // ---------------------------------------------------------------------------
  const params = new URLSearchParams(location.search);
  const TENANT_SLUG = params.get('tenant') || '';
  const VICI2_WEB_ORIGIN = params.get('web_origin') || location.origin;
  const SF_API_VERSION = params.get('api_version') || '58.0';

  if (!TENANT_SLUG) {
    console.error('[vici2-cti] Missing ?tenant= parameter');
  }

  // ---------------------------------------------------------------------------
  // 2. Load opencti_min.js from the Salesforce instance dynamically
  //    SF parent frame origin is detected from the first postMessage or referrer.
  // ---------------------------------------------------------------------------
  let sfOriginResolved = false;
  let openCtiReady = false;

  function loadOpenCtiLib(sfInstanceUrl) {
    if (sfOriginResolved) return;
    sfOriginResolved = true;
    const script = document.createElement('script');
    script.src = `${sfInstanceUrl}/support/api/${SF_API_VERSION}/lightning/opencti_min.js`;
    script.onload = onOpenCtiLoaded;
    script.onerror = function () {
      console.error('[vici2-cti] Failed to load opencti_min.js from', sfInstanceUrl);
    };
    document.head.appendChild(script);
  }

  function isSalesforceOrigin(origin) {
    return (
      origin.includes('.salesforce.com') ||
      origin.includes('.lightning.force.com') ||
      origin.includes('.visualforce.com') ||
      origin.includes('.force.com')
    );
  }

  // Salesforce always posts the first message from the instance domain;
  // capture it to detect the SF origin.
  window.addEventListener('message', function detectSfOrigin(e) {
    if (!sfOriginResolved && e.data && typeof e.data === 'object') {
      if (isSalesforceOrigin(e.origin)) {
        window.removeEventListener('message', detectSfOrigin);
        loadOpenCtiLib(e.origin);
      }
    }
  }, false);

  // Fallback: detect from document.referrer
  if (document.referrer) {
    try {
      const ref = new URL(document.referrer);
      if (isSalesforceOrigin(ref.hostname)) {
        loadOpenCtiLib(ref.origin);
      }
    } catch { /* malformed referrer */ }
  }

  // ---------------------------------------------------------------------------
  // 3. State machine
  // ---------------------------------------------------------------------------
  const State = Object.freeze({ IDLE: 'IDLE', INCALL: 'INCALL', DISPO_PENDING: 'DISPO_PENDING' });
  let _currentState = State.IDLE;
  let _pendingCallId = null;

  // ---------------------------------------------------------------------------
  // 4. vici2 inner iframe management
  // ---------------------------------------------------------------------------
  const frame = document.getElementById('vici2-frame');
  const loadingEl = document.getElementById('sf-cti-loading');

  function getVici2Url() {
    return `${VICI2_WEB_ORIGIN}/sf?embed=sf&tenant=${encodeURIComponent(TENANT_SLUG)}`;
  }

  function mountVici2Frame() {
    frame.src = getVici2Url();
    frame.style.display = 'block';
    if (loadingEl) loadingEl.style.display = 'none';
  }

  function postToVici2(msg) {
    if (frame && frame.contentWindow) {
      frame.contentWindow.postMessage(msg, VICI2_WEB_ORIGIN);
    }
  }

  // ---------------------------------------------------------------------------
  // 5. Open CTI event handlers (registered after opencti_min.js loads)
  // ---------------------------------------------------------------------------
  function onOpenCtiLoaded() {
    openCtiReady = true;

    // Click-to-dial listener
    sforce.opencti.onClickToDial({
      listener: function (payload) {
        handleSfDial(payload);
      }
    });

    // Navigation listener
    sforce.opencti.onNavigationChange({
      listener: function (payload) {
        postToVici2({
          type: 'sf:navigate',
          recordId: payload.recordId,
          objectType: payload.objectType,
        });
      }
    });

    // Softphone panel open/close
    sforce.opencti.onSoftphoneOpen({ listener: function () {
      postToVici2({ type: 'sf:panelOpen' });
    }});
    sforce.opencti.onSoftphoneClose({ listener: function () {
      postToVici2({ type: 'sf:panelClose' });
    }});

    // Gather app view info for sf:init
    sforce.opencti.getAppViewInfo({ callbackFunction: function (res) {
      if (res && res.success && res.returnValue) {
        postToVici2({
          type: 'sf:init',
          userId: res.returnValue.userId,
          orgId: res.returnValue.orgId,
          apiVersion: res.returnValue.apiVersion || SF_API_VERSION,
          tenantSlug: TENANT_SLUG,
        });
      }
    }});

    // Enable click-to-dial
    sforce.opencti.enableClickToDial();

    // Mount the vici2 agent UI
    mountVici2Frame();
  }

  function handleSfDial(payload) {
    _currentState = State.IDLE; // reset if a new dial starts
    postToVici2({
      type: 'sf:dial',
      number: payload.number,
      recordId: payload.recordId,
      recordName: payload.recordName,
      objectType: payload.objectType,
    });
  }

  // ---------------------------------------------------------------------------
  // 6. Message handler for messages from the vici2 inner iframe
  // ---------------------------------------------------------------------------
  window.addEventListener('message', function (e) {
    if (e.origin !== VICI2_WEB_ORIGIN) return;
    const msg = e.data;
    if (!msg || typeof msg.type !== 'string') return;
    handleVici2Message(msg);
  }, false);

  function handleVici2Message(msg) {
    switch (msg.type) {
      case 'vici2:callConnected':
        handleCallConnected(msg);
        break;
      case 'vici2:callEnded':
        handleCallEnded(msg);
        break;
      case 'vici2:dispoCommitted':
        handleDispoCommitted(msg);
        break;
      case 'vici2:agentState':
        // Phase 1: no-op (could drive panel visibility in future)
        break;
      case 'vici2:screenPop':
        if (openCtiReady && msg.sfRecordId) {
          sforce.opencti.screenPop({
            type: 'SOBJECT',
            params: { recordId: msg.sfRecordId },
            callbackFunction: noop,
          });
        }
        break;
    }
  }

  function handleCallConnected(msg) {
    _currentState = State.INCALL;
    _pendingCallId = msg.callId;

    if (!openCtiReady) return;

    sforce.opencti.setSoftphonePanelVisibility({ visible: true, callbackFunction: noop });

    if (msg.sfRecordId) {
      sforce.opencti.screenPop({
        type: 'SOBJECT',
        params: { recordId: msg.sfRecordId },
        callbackFunction: noop,
      });
    } else if (msg.leadPhone) {
      sforce.opencti.searchAndScreenPop({
        searchParams: msg.leadPhone,
        queryParams: { search: msg.leadPhone },
        callbackFunction: noop,
      });
    }
  }

  function handleCallEnded(msg) {
    void msg;
    _currentState = State.DISPO_PENDING;
  }

  function handleDispoCommitted(msg) {
    _currentState = State.IDLE;
    _pendingCallId = null;

    if (!openCtiReady) return;

    const taskValue = buildSfTask(msg);
    sforce.opencti.saveLog({
      value: taskValue,
      callbackFunction: function (res) {
        if (res && !res.success) {
          console.warn('[vici2-cti] saveLog failed', res.errors);
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 7. SF Task construction from dispo commit payload
  // ---------------------------------------------------------------------------
  const DEFAULT_STATUS_MAP = {
    SALE:     'Completed',
    NOANSWER: 'Not Started',
    BUSY:     'Not Started',
    DNC:      'Deferred',
    CBHOLD:   'In Progress',
    CALLBACK: 'In Progress',
  };

  function buildSfTask(msg) {
    const taskStatus = DEFAULT_STATUS_MAP[msg.dispo] || 'Completed';
    const callDate = msg.callStartAt
      ? msg.callStartAt.substring(0, 10)
      : new Date().toISOString().substring(0, 10);

    const task = {
      Subject: `Call: ${msg.dispoLabel || msg.dispo}`,
      Status: taskStatus,
      ActivityDate: callDate,
      CallDurationInSeconds: msg.callDurationSeconds || 0,
      CallType: msg.direction === 'inbound' ? 'Inbound' : 'Outbound',
      Description:
        `[vici2:callId:${msg.callId}]\n` +
        (msg.notes ? `Notes: ${msg.notes}\n` : ''),
    };

    if (msg.sfRecordId) {
      // Both Lead and Contact use WhoId in SF
      task.WhoId = msg.sfRecordId;
    }

    return task;
  }

  function noop() {}
})();
