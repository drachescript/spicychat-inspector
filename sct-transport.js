/* Transport boundary for SCT. No endpoint, authorization or retry contract is
   approved yet. This module intentionally cannot send data, even if called. */
(function(root){'use strict';
 const DESTINATION_ORIGIN='https://spicychat-creatortools.drache.uk';
 function validOrigin(raw){try{const u=new URL(raw);return u.origin===DESTINATION_ORIGIN&&u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash;}catch(_){return false;}}
 function status(){return {enabled:false,status:'not-configured',destinationOrigin:DESTINATION_ORIGIN,authorization:'not-configured',retryPolicy:'inactive'};}
 async function sendRecording(){return {ok:false,...status()};}
 root.SCTTransport=Object.freeze({status,validOrigin,sendRecording});
})(globalThis);
