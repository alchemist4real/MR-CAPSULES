/**
 * Mr. Capsules Client Telemetry SDK
 * Captures learning analytics, CBT quiz scores, and user activity with zero UI performance impact.
 */
(function(window) {
  'use strict';

  var _queue = [];
  var _flushTimer = null;
  var _sessionId = 'sess_' + Math.random().toString(36).substring(2, 10) + '_' + Date.now();
  var _endpoint = '/api/telemetry';

  function getDeviceId() {
    try {
      var match = document.cookie.match(/(?:^|;\s*)mr_device_id=([^;]*)/);
      if (match && match[1]) return decodeURIComponent(match[1]);
      var localId = localStorage.getItem('mr_device_id') || localStorage.getItem('capsule_device_id');
      if (localId) return localId;
    } catch (e) {}
    return 'dev_anon';
  }

  function getAuthToken() {
    try {
      if (window.supabaseClient && typeof window.supabaseClient.auth?.getSession === 'function') {
        // Will be picked up asynchronously or from cached session in storage
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.startsWith('sb-') && k.endsWith('-auth-token')) {
            var raw = localStorage.getItem(k);
            if (raw) {
              var parsed = JSON.parse(raw);
              if (parsed && parsed.access_token) return parsed.access_token;
            }
          }
        }
      }
    } catch (e) {}
    return null;
  }

  function getUserInfo() {
    var info = { user_id: null, user_email: null, is_guest: false };
    try {
      var guestActive = localStorage.getItem('capsule_guest_active') === 'true' || 
                        sessionStorage.getItem('capsule_guest_active') === 'true';
      if (guestActive) {
        info.is_guest = true;
        info.user_email = localStorage.getItem('capsule_guest_email') || 'guest@mrcapsules.com';
      }
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.startsWith('sb-') && k.endsWith('-auth-token')) {
          var raw = localStorage.getItem(k);
          if (raw) {
            var parsed = JSON.parse(raw);
            if (parsed && parsed.user) {
              info.user_id = parsed.user.id || null;
              info.user_email = parsed.user.email || info.user_email;
              info.is_guest = parsed.user.user_metadata?.is_guest === true || info.is_guest;
            }
          }
        }
      }
    } catch (e) {}
    return info;
  }

  var CapsuleTracker = {
    init: function(opts) {
      if (opts && opts.endpoint) _endpoint = opts.endpoint;
      
      // Auto-flush on page unload / background
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', function() {
          if (document.visibilityState === 'hidden') {
            CapsuleTracker.flush(true);
          }
        });
      }
      if (typeof window !== 'undefined') {
        window.addEventListener('pagehide', function() {
          CapsuleTracker.flush(true);
        });
        window.addEventListener('beforeunload', function() {
          CapsuleTracker.flush(true);
        });
      }
    },

    track: function(eventType, payload, severity) {
      if (!eventType) return;
      var uInfo = getUserInfo();
      var ev = {
        event_type: String(eventType).trim(),
        severity: severity || 'info',
        payload: payload || {},
        session_id: _sessionId,
        device_id: getDeviceId(),
        user_id: uInfo.user_id,
        user_email: uInfo.user_email,
        is_guest: uInfo.is_guest,
        timestamp: Date.now()
      };

      _queue.push(ev);

      // Instant flush for critical/error events, else batch debounce 4s
      if (severity === 'security' || severity === 'error') {
        CapsuleTracker.flush(false);
      } else {
        if (!_flushTimer) {
          _flushTimer = setTimeout(function() {
            _flushTimer = null;
            CapsuleTracker.flush(false);
          }, 4000);
        }
      }
    },

    flush: function(isBeacon) {
      if (_flushTimer) {
        clearTimeout(_flushTimer);
        _flushTimer = null;
      }
      if (_queue.length === 0) return;

      var batch = _queue.slice();
      _queue = [];

      var token = getAuthToken();
      var postData = JSON.stringify({ events: batch });

      // If page is unloading and sendBeacon is supported, prefer sendBeacon
      if (isBeacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        var blob = new Blob([postData], { type: 'application/json' });
        var sent = navigator.sendBeacon(_endpoint, blob);
        if (sent) return;
      }

      // Standard fetch with keepalive fallback
      var headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = 'Bearer ' + token;

      try {
        fetch(_endpoint, {
          method: 'POST',
          headers: headers,
          body: postData,
          keepalive: true
        }).catch(function(err) {
          // Put back un-sent events if failed
          if (_queue.length < 50) {
            _queue = batch.concat(_queue);
          }
        });
      } catch (e) {
        if (_queue.length < 50) {
          _queue = batch.concat(_queue);
        }
      }
    },

    // High-yield convenience methods for medical learning analytics
    trackCbtStart: function(moduleId, totalQuestions) {
      CapsuleTracker.track('cbt:exam_started', {
        module_id: moduleId,
        total_questions: totalQuestions || 0
      });
    },

    trackCbtSubmit: function(moduleId, score, totalQuestions, durationSec, incorrectList) {
      var pct = (totalQuestions > 0) ? Math.round((score / totalQuestions) * 1000) / 10 : 0;
      CapsuleTracker.track('cbt:exam_submitted', {
        module_id: moduleId,
        score: score,
        total_questions: totalQuestions,
        score_pct: pct,
        duration_seconds: durationSec || 0,
        incorrect_questions: incorrectList || []
      });
    },

    trackModuleView: function(modulePath, title) {
      CapsuleTracker.track('module:view', {
        path: modulePath,
        title: title || ''
      });
    },

    trackModuleDwell: function(modulePath, activeMinutes) {
      CapsuleTracker.track('module:dwell', {
        path: modulePath,
        active_minutes: activeMinutes || 1
      });
    },

    trackSearch: function(query, resultsCount) {
      if (!query || query.trim().length < 2) return;
      CapsuleTracker.track('search:query', {
        query: query.trim(),
        results_count: resultsCount || 0
      });
    }
  };

  CapsuleTracker.init();
  window.CapsuleTracker = CapsuleTracker;
})(typeof window !== 'undefined' ? window : this);
