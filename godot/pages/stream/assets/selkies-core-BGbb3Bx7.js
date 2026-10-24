(function(){let e=document.createElement(`link`).relList;if(e&&e.supports&&e.supports(`modulepreload`))return;for(let e of document.querySelectorAll(`link[rel="modulepreload"]`))n(e);new MutationObserver(e=>{for(let t of e)if(t.type===`childList`)for(let e of t.addedNodes)e.tagName===`LINK`&&e.rel===`modulepreload`&&n(e)}).observe(document,{childList:!0,subtree:!0});function t(e){let t={};return e.integrity&&(t.integrity=e.integrity),e.referrerPolicy&&(t.referrerPolicy=e.referrerPolicy),t.credentials=e.crossOrigin===`use-credentials`?`include`:e.crossOrigin===`anonymous`?`omit`:`same-origin`,t}function n(e){if(e.ep)return;e.ep=!0;let n=t(e);fetch(e.href,n)}})();var e={1:`h264`,2:`vp8`,3:`vp9`,4:`av1`,5:`h265`},t={jpeg:`jpeg`,h264enc:`h264`,"h264enc-striped":`h264`,h265enc:`h265`,vp8enc:`vp8`,vp9enc:`vp9`,av1enc:`av1`},n=t=>e[t>>4]||`h264`,r=e=>(e&15)==1,i=e=>t[e]||`h264`,a=e=>e===`h264`||e===`h265`||e===`vp9`,o=e=>e===`h264`||e===`h265`||e===`vp9`||e===`av1`,s=e=>{let t=[],n=e.length,r=-1;for(let i=0;i+2<n;i++)if(e[i]===0&&e[i+1]===0&&e[i+2]===1){if(r>=0){let n=i;for(;n>r&&e[n-1]===0;)n--;n>r&&t.push(e.subarray(r,n))}r=i+3,i+=2}return r>=0&&r<n&&t.push(e.subarray(r,n)),t},c=(e,t,n,r=!1)=>{let i=[],a=0;for(let o=t;o<e.length&&i.length<n;o++){let t=e[o];if(!r&&a>=2&&t===3){a=0;continue}a=t===0?a+1:0,i.push(t)}let o=0;return{u:e=>{let t=0;for(let n=0;n<e;n++){let e=i[o>>3],n=e===void 0?0:e>>7-(o&7)&1;t=t*2+n,o++}return t},skip:e=>{o+=e}}},l=e=>{if(!e||e.length<5)return null;let t=e=>e.toString(16).toUpperCase().padStart(2,`0`);for(let n of s(e))if(!(n[0]&128)&&(n[0]&31)==7)return n.length<4?null:`avc1.${t(n[1])}${t(n[2])}${t(n[3])}`;return null},u=e=>{if(!e||e.length<5)return null;for(let t of s(e)){if((t[0]>>1&63)!=33||t.length<16)continue;let e=c(t,2,32);e.skip(8);let n=e.u(2),r=e.u(1),i=e.u(5),a=0;for(let t=0;t<32;t++)a|=e.u(1)<<t;let o=[];for(let t=0;t<6;t++)o.push(e.u(8));let s=e.u(8);for(;o.length>1&&o[o.length-1]===0;)o.pop();let l=[``,`A`,`B`,`C`][n],u=(a>>>0).toString(16).toUpperCase(),d=o.map(e=>e.toString(16).toUpperCase()).join(`.`);return`hev1.${l}${i}.${u}.${r?`H`:`L`}${s}.${d}`}return null},d=e=>{if(!e||e.length<2)return null;let t=0;for(;t<e.length;){let n=e[t],r=n>>3&15,i=!!(n&4),a=!!(n&2),o=t+1+ +!!i,s=e.length-o;if(a){s=0;let t=0;for(;;){if(o>=e.length||t>28)return null;let n=e[o++];if(s+=(n&127)*2**t,!(n&128))break;t+=7}}if(r===1){let t=c(e,o,s,!0),n=t.u(3);t.skip(1);let r=t.u(1),i,a=0;if(r)i=t.u(5);else{let e=t.u(1),n=0,r=0;if(e){if(t.skip(64),t.u(1)){let e=0;for(;t.u(1)===0&&e<32;)e++;t.skip(e)}n=t.u(1),n&&(r=t.u(5)+1,t.skip(42))}let o=t.u(1),s=t.u(5)+1;for(let e=0;e<s;e++){t.skip(12);let s=t.u(5),c=s>7?t.u(1):0;e===0&&(i=s,a=c),n&&t.u(1)&&t.skip(r*2+1),o&&t.u(1)&&t.skip(4)}}let l=t.u(4)+1,u=t.u(4)+1;t.skip(l+u);let d;r?t.skip(3):(t.u(1)&&t.skip(7),t.skip(7),d=t.u(1),d&&t.skip(2),(t.u(1)?2:t.u(1))>0&&!t.u(1)&&t.skip(1),d&&t.skip(3)),t.skip(3);let f=t.u(1)?n===2&&t.u(1)?12:10:8;return`av01.${n}.${String(i).padStart(2,`0`)}${a?`H`:`M`}.${String(f).padStart(2,`0`)}`}t=o+s}return null},f=e=>{if(!e||e.length<1)return 0;let t=e[0];return t>>5&1|(t>>4&1)<<1},p=e=>{let t=f(e);if(t<2||!e||e.length<5)return 8;let n=c(e,0,8);return n.skip(t===3?5:4),n.u(1)||n.u(1)?10:(n.skip(26),n.u(1)?12:10)},m=(e,t,n)=>{let r=e*t,i=r*(n>0?n:60);for(let[e,t,n]of[[`10`,829440,36864],[`11`,2764800,73728],[`20`,4608e3,122880],[`21`,9216e3,245760],[`30`,20736e3,552960],[`31`,36864e3,983040],[`40`,83558400,2228224],[`41`,160432128,2228224],[`50`,311951360,8912896],[`51`,588251136,8912896],[`52`,1176502272,8912896],[`60`,1176502272,35651584],[`61`,2353004544,35651584],[`62`,4706009088,35651584]])if(i<=t&&r<=n)return e;return`62`},h=(e,t,n)=>{let r=e*t,i=r*(n>0?n:60);for(let[n,a,o,s,c]of[[8,2359296,6144,3456,70778880],[9,2359296,6144,3456,141557760],[12,8912896,8192,4352,267386880],[13,8912896,8192,4352,534773760],[14,8912896,8192,4352,1069547520],[15,8912896,8192,4352,1069547520],[16,35651584,16384,8704,1069547520],[17,35651584,16384,8704,2139095040],[18,35651584,16384,8704,4278190080],[19,35651584,16384,8704,4278190080]])if(r<=a&&e<=o&&t<=s&&i<=c)return n;return 19},g=(e,t,n)=>{let r=Math.ceil(e/16)*Math.ceil(t/16),i=r*Math.max(n>0?n:60,60);for(let[e,t,n]of[[41,8192,245760],[42,8704,522240],[50,22080,589824],[51,36864,983040],[52,36864,2073600],[60,139264,4177920],[61,139264,8355840],[62,139264,16711680]])if(r<=t&&i<=n)return e.toString(16).toUpperCase().padStart(2,`0`);return`3E`},_=(e,t,n,r,i)=>i?`avc1.${n?`F400`:`6400`}${g(e,t,r)}`:`avc1.42E01E`,ee=(e,t,n,r,i,a,o)=>{switch(e){case`h265`:return t&&u(t)||(a?`hev1.4.10.L153.9E.8`:`hev1.1.6.L153.B0`);case`vp8`:return`vp8`;case`vp9`:return`vp09.0${t?f(t):0}.${m(n,r,i)}.${String(t?p(t):8).padStart(2,`0`)}`;case`av1`:return t&&d(t)||`av01.0.${String(h(n,r,i)).padStart(2,`0`)}M.08`;default:return t&&l(t)||_(n,r,a,i,o)}},te=(e,t=!1)=>{let n=e===`vp8`;return{primaries:`bt709`,transfer:`bt709`,matrix:n?`smpte170m`:`bt709`,fullRange:!n&&!!t}},ne=`AAAAAWdCwArd7ARAAAADAEAAAA8DxIngAAAAAWjOD8gAAAABZYiEOiYoDg==`,re=e=>{let t=null,n=null;for(let r of s(e)){let e=r[0]&31;e===7&&!t?t=r:e===8&&!n&&(n=r)}if(!t||!n)return null;let r=new Uint8Array(11+t.length+n.length);return r.set([1,t[1],t[2],t[3],255,225,t.length>>8,t.length&255],0),r.set(t,8),r.set([1,n.length>>8,n.length&255],8+t.length),r.set(n,11+t.length),r},ie=e=>{let t=s(e).filter(e=>{let t=e[0]&31;return t!==7&&t!==8&&t!==9}),n=0;for(let e of t)n+=4+e.length;let r=new Uint8Array(n),i=0;for(let e of t)r[i]=e.length>>>24,r[i+1]=e.length>>>16&255,r[i+2]=e.length>>>8&255,r[i+3]=e.length&255,r.set(e,i+4),i+=4+e.length;return r},ae=(e,t)=>{if(!e||!t)return!e&&!t;if(e.length!==t.length)return!1;for(let n=0;n<e.length;n++)if(e[n]!==t[n])return!1;return!0},oe={h264:`avc1.42E01E`,h265:`hev1.1.6.L93.B0`,vp8:`vp8`,vp9:`vp09.00.31.08`,av1:`av01.0.05M.08`},v={h264:`AAAAAWduAA2mzZQUH7ARAAADAAEAAAMAPA8UKZYAAAABaOvjyyLAAAABZYiEADf//vbw/gNCUJcRzeidMx+/Fbi6NDe9zgACrU8Qb7gsE2lPYBBAAAGfEd0SuCykEBAvSus=`,h264444:`AAAAAWf0AA2Q2bKCg/YCIAAAAwAgAAAHgeKFMsAAAAABaOvjxEhEAAABZYiEADf//vaH+A0Lun/9P+C6zp85f52wAAq0QAbCNhAp8AAAAwAAAwAAAwACNw==`,h265:`AAAAAUABDAH//wIgAAADAJAAAAMAAAMAPJWYCQAAAAFCAQECIAAAAwCQAAADAAADADygCggPE2WVmkkyvAWgIAAAAwAgAAADA8EAAAABRAHBcrQiQAAAASgBrwhg+Snjmyr/oamsIyBbC7MwAAADAAADAAADAAADAAADAPSA`,h265444:`AAAAAUABDAH//wQIAAADAJwIAAADAAA8lZgJAAAAAUIBAQQIAAADAJwIAAADAAA8kAFBAeJssrNJJleAtAQAAAMABAAAAwB4IAAAAAFEAcFyhgxCJAAAASgBrwhg+Snjmyr/oamsIyBbC7MwAAADAAADAAADAAADAAADAPSA`,vp9:`kkmDQgAJ+Ad7ABwSDgxJAAAYYAAAZzaRO7i1N12+muU5wAA=`,vp9444:`sSTBoQAAn4B3sAHBIODEkAABgGAAAGc2kOnpLRNlZkoaQGA=`,av1:`EgAKCwAAAAQ8/7xq+cBAMhcQAJEAhBAggIAAAgF1u6aQC9g5Dyf14A==`},y={h264:`avc1.F4001E`,h265:`hev1.4.10.L93.9E.8`,vp9:`vp09.01.10.08.03`},b=class{constructor(...e){this.items=[],this.enqueue(...e)}enqueue(...e){e.forEach(e=>this.items.push(e))}dequeue(e=1){return this.items.splice(0,e)[0]}size(){return this.items.length}isEmpty(){return this.items.length===0}toArray(){return[...this.items]}remove(e){var t=this.items.indexOf(e);this.items.splice(t,1)}find(e){return this.items.indexOf(e)!=-1}clear(){this.items.length=0}},x={websockets:`WebSockets`,webrtc:`WebRTC`,h264enc:`H.264`,h265enc:`H.265`,vp8enc:`VP8`,vp9enc:`VP9`,av1enc:`AV1`,"h264enc-striped":`H.264 (Striped)`,jpeg:`JPEG (Striped)`,cbr:`CBR (Constant Bitrate)`,crf:`CRF (Constant Quality)`,auto:`Auto`,h264:`H.264`,h265:`H.265`,vp8:`VP8`,vp9:`VP9`,av1:`AV1`,mjpeg:`MJPEG`},se=e=>x[e]??e,ce=1e4;async function le(e,t,n){if(typeof VideoDecoder>`u`)return!1;for(let r of[void 0,`prefer-software`])try{let i={codec:e,codedWidth:t,codedHeight:n};r&&(i.hardwareAcceleration=r);let a=await Promise.race([VideoDecoder.isConfigSupported(i),new Promise(e=>setTimeout(e,ce))]);if(a&&a.supported)return!0;if(a===void 0)return null}catch{}return!1}var ue=null;(async()=>{let e={};for(let[t,n]of Object.entries(oe))e[t]=await le(n,1280,720);return ue=e,e})();var de=(async()=>{if(typeof VideoDecoder>`u`)return`annexb`;let e=Uint8Array.from(atob(ne),e=>e.charCodeAt(0)),t=await new Promise(t=>{let n=null,r=e=>{if(t(e),n)try{n.terminate()}catch{}},i=setTimeout(()=>r(`annexb`),5e3);try{n=new Worker(URL.createObjectURL(new Blob([`self.onmessage = async (e) => {
        let outputs = 0;
        try {
            const dec = new VideoDecoder({ output: (f) => { outputs++; f.close(); }, error: () => {} });
            dec.configure({ codec: 'avc1.42000A', codedWidth: 16, codedHeight: 16, optimizeForLatency: true });
            dec.decode(new EncodedVideoChunk({ type: 'key', timestamp: 0, data: e.data }));
            await dec.flush();
            dec.close();
        } catch (err) { /* refused: the count says so */ }
        self.postMessage(outputs > 0 ? 'annexb' : 'avcc');
    };`],{type:`text/javascript`}))),n.onmessage=e=>{clearTimeout(i),r(e.data)},n.onerror=()=>{clearTimeout(i),r(`annexb`)},n.postMessage(e.buffer,[e.buffer])}catch{clearTimeout(i),r(`annexb`)}});return fe=t,t})(),fe=`annexb`,pe=()=>fe,me=e=>e===`jpeg`?!0:typeof VideoDecoder>`u`?!1:ue===null||ue[i(e)]!==!1,he={h264enc:`video/h264`,h265enc:`video/h265`,vp8enc:`video/vp8`,vp9enc:`video/vp9`,av1enc:`video/av1`},ge=e=>{let t=he[e];if(!t)return!1;try{let e=RTCRtpReceiver.getCapabilities(`video`);return!e||!Array.isArray(e.codecs)||e.codecs.some(e=>typeof e.mimeType==`string`&&e.mimeType.toLowerCase()===t)}catch{return!0}},_e={};function ve(e=`h264`){let t=y[e];return t?(_e[e]||(_e[e]=le(t,320,240).then(t=>{let n=t===!0;return ye[e]=n,n})),_e[e]):Promise.resolve(!1)}var ye={},be=e=>ye[e],xe={},Se={},Ce=(e,t=!1)=>`${e}${t?`444`:``}`;function we(e,t=!1){let n=Ce(e,t),r=v[n];return!r||typeof VideoDecoder>`u`?Promise.resolve(!1):(xe[n]||(xe[n]=(async()=>{let i=Uint8Array.from(atob(r),e=>e.charCodeAt(0)),a=0,o=null;try{o=new VideoDecoder({output:e=>{a++,e.close()},error:()=>{}}),o.configure({codec:ee(e,i,320,240,30,t,!0),codedWidth:320,codedHeight:240,optimizeForLatency:!0}),o.decode(new EncodedVideoChunk({type:`key`,timestamp:0,data:i})),await Promise.race([o.flush(),new Promise(e=>setTimeout(e,ce))])}catch{}try{o&&o.state!==`closed`&&o.close()}catch{}return Se[n]=a>0,a>0})()),xe[n])}var Te=(e,t=!1)=>Se[Ce(e,t)];function Ee(){let e=window.location.pathname;return e.substring(0,e.lastIndexOf(`/`)+1).replace(/\/$/,``)}var S=5e3;async function De(e,t){try{let n=typeof AbortSignal.timeout==`function`?AbortSignal.timeout(S):void 0,r=await fetch(e,{cache:`no-store`,headers:t,signal:n});return[502,503,504].includes(r.status)?null:r}catch{return null}}async function Oe(e){try{let t=typeof AbortSignal.timeout==`function`?AbortSignal.timeout(S):void 0,n=await fetch(window.location.href,{method:`HEAD`,cache:`no-store`,headers:e,signal:t});return n.ok?`${n.headers.get(`etag`)||``}|${n.headers.get(`last-modified`)||``}`:null}catch{return null}}function ke(){return typeof window>`u`?``:(window.location.origin+window.location.pathname).replace(/[^a-zA-Z0-9._-]/g,`_`)}function Ae(){if(typeof navigator>`u`)return!1;let e=navigator.platform||navigator.userAgentData&&navigator.userAgentData.platform||``;return/^mac/i.test(e)&&(navigator.maxTouchPoints||0)<=1}function C(){let e=`selkies_tab_id`;try{let t=window.sessionStorage.getItem(e);return t||(t=window.crypto&&window.crypto.randomUUID?window.crypto.randomUUID():`${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`,window.sessionStorage.setItem(e,t)),t}catch{return null}}var w=864e5;function T(e){return`${ke()}_cc_start${e&&e!==`primary`?`_${e}`:``}`}function je(e,t){if(!(!Number.isFinite(t)||t<=0))try{window.localStorage.setItem(T(e),JSON.stringify({kbps:Math.round(t),at:Date.now()}))}catch{}}function E(e){try{let t=JSON.parse(window.localStorage.getItem(T(e))||`null`);if(t&&Number.isFinite(t.kbps)&&t.kbps>0&&Date.now()-t.at<w)return t.kbps}catch{}return null}function Me(e){try{window.localStorage.removeItem(T(e))}catch{}}function D(e,t){return/AppleWebKit\//.test(e||``)&&!/Chrom(e|ium)\/|Edg\/|OPR\//.test(e||``)&&/^Linux/.test(t||``)}var Ne=typeof window<`u`&&typeof window.matchMedia==`function`&&window.matchMedia(`(pointer: coarse)`).matches;function Pe(e){let t=e&&e.name;return t===`NotAllowedError`||t===`SecurityError`||t===`NotSupportedError`}var Fe=``;function Ie(){document.title=`Selkies`,fetch(`manifest.json`).then(e=>e.json()).then(e=>{e.name&&!Fe&&(document.title=e.name)}).catch(()=>{})}function Le(e){let t=e.ui_title;t&&t.overridden&&t.value&&(Fe=String(t.value),document.title=Fe)}function O(e,t){let n=e=>e.split(/(?=^m=)/m),r=n(e),i=n(t);if(r.length!==i.length)return t;for(let e=1;e<r.length;e++){let t=r[e];if(!t.startsWith(`m=audio`)||/^a=recvonly/m.test(t))continue;let n=t.match(/^a=rtpmap:(\d+) multiopus\//m);if(!n)continue;let a=n[1],o=RegExp(`^a=(rtpmap|fmtp|rtcp-fb):${a} `),s=t.split(/\r?\n/).filter(e=>o.test(e)),c=i[e].split(`\r
`),l=c[0].split(` `);if(l[1]===`0`||l.slice(3).includes(a))continue;c[0]=[...l.slice(0,3),a,...l.slice(3)].join(` `);let u=c.findIndex(e=>e.startsWith(`a=rtpmap:`));c.splice(u<0?c.length-1:u,0,...s),i[e]=c.join(`\r
`)}return i.join(``)}var Re=class{constructor(e,t,n){this.signaling=e,this.element=t,this.peer_id=n,this.forceTurn=!1,this.rtcPeerConfig={lifetimeDuration:`86400s`,iceServers:[{urls:[`stun:stun.l.google.com:19302`]}],blockStatus:`NOT_BLOCKED`,iceTransportPolicy:`all`},this.peerConnection=null,this._micTransceiver=null,this._micStream=null,this._micPending=null,this._webcamTransceiver=null,this._webcamStream=null,this._webcamPending=null,this.onstatus=null,this.ondebug=null,this.onerror=null,this.onconnectionstatechange=null,this.ondatachannelopen=null,this.ondatachannelclose=null,this.onstreaminfo=null,this.onlatencymeasurement=null,this.onplaystreamrequired=null,this.onclipboardcontent=null,this.onsystemaction=null,this.oncursorchange=null,this.cursor_cache=new Map,this.onstreamstats=null,this.onconnection=null,this.signaling.onsdp=this._onSDP.bind(this),this.signaling.onice=this._onSignalingICE.bind(this),this._connected=!1,this._send_channel=null,this._motion_channel=null,this._gzTx=!1,this._sendQueue=Promise.resolve(),this._recvQueue=Promise.resolve(),this.input=null,this.clipboardcontent=[],this.onserversettings=null,this.ondisplaysettings=null,this.ondisplayconfig=null,this.onprintdocument=null,this.onccrate=null}_setStatus(e){this.onstatus!==null&&this.onstatus(e)}_setDebug(e){this.ondebug!==null&&this.ondebug(e)}_setError(e){this.onerror!==null&&this.onerror(e)}_setConnectionState(e){this.onconnectionstatechange!==null&&this.onconnectionstatechange(e)}_onSignalingICE(e){if(this._setDebug(`received ice candidate from signaling server: `+JSON.stringify(e)),this.forceTurn&&JSON.stringify(e).indexOf(`relay`)<0){this._setDebug(`Rejecting non-relay ICE candidate: `+JSON.stringify(e));return}this.peerConnection.addIceCandidate(e).catch(this._setError)}_onPeerICE(e){if(e.candidate===null){this._setStatus(`Completed ICE candidates from peer connection`);return}this.signaling.sendICE(e.candidate)}_onSDP(e){if(e.type!=`offer`){this._setError(`received SDP was not type offer.`);return}console.log(`Received remote SDP`,e),this.peerConnection.setRemoteDescription(e).then(()=>{this._setDebug(`received SDP offer, creating answer`),this._prepareUplinkTransceivers(e.sdp),this.peerConnection.createAnswer().then(t=>{if(!/[^-]sps-pps-idr-in-keyframe=1[^\d]/gm.test(t.sdp)&&/[^-]packetization-mode=/gm.test(t.sdp)&&(console.log(`Overriding WebRTC SDP to include sps-pps-idr-in-keyframe=1`),t.sdp=/[^-]sps-pps-idr-in-keyframe=\d+/gm.test(t.sdp)?t.sdp.replace(/sps-pps-idr-in-keyframe=\d+/gm,`sps-pps-idr-in-keyframe=1`):t.sdp.replace(`packetization-mode=`,`sps-pps-idr-in-keyframe=1;packetization-mode=`)),t.sdp.indexOf(`multiopus`)===-1){!/[^-]stereo=1[^\d]/gm.test(t.sdp)&&/[^-]useinbandfec=/gm.test(t.sdp)&&(console.log(`Overriding WebRTC SDP to allow stereo audio`),t.sdp=/[^-]stereo=\d+/gm.test(t.sdp)?t.sdp.replace(/stereo=\d+/gm,`stereo=1`):t.sdp.replace(`useinbandfec=`,`stereo=1;useinbandfec=`));let n=e.sdp.match(/^a=ptime:(\d+)/m),r=Math.max(3,Math.min(10,n?parseInt(n[1],10):10));!RegExp(`[^-]minptime=`+r+`[^\\d]`,`gm`).test(t.sdp)&&/[^-]useinbandfec=/gm.test(t.sdp)&&(console.log(`Overriding WebRTC SDP to allow low-latency audio packet (minptime=`+r+`)`),t.sdp=/[^-]minptime=\d+/gm.test(t.sdp)?t.sdp.replace(/minptime=\d+/gm,`minptime=`+r):t.sdp.replace(`useinbandfec=`,`minptime=`+r+`;useinbandfec=`))}console.log(`Created local SDP`,t);let n=t.sdp,r=O(e.sdp,n),i=e=>this.peerConnection.setLocalDescription({type:`answer`,sdp:e}),a=()=>this.peerConnection.getReceivers().some(e=>e.track&&e.track.kind===`audio`&&e.getParameters().codecs.some(e=>/multiopus/i.test(e.mimeType)));(r===n?i(n):i(r).catch(()=>i(n))).then(()=>{this._setDebug(`Sending SDP answer`);let e=this.peerConnection.localDescription,t=e.sdp!==n&&e.sdp.indexOf(`multiopus`)!==-1;this.signaling.sendSDP(t&&!a()?{type:`answer`,sdp:n}:e)}).catch(e=>{this._setError(`Error setting local description: `+e)})}).catch(()=>{this._setError(`Error creating local SDP`)})}).catch(e=>{this._setError(`Error setting remote description: `+e)})}_prepareUplinkTransceivers(e){if(this._micTransceiver=null,this._webcamTransceiver=null,!e||!this.peerConnection)return;let t={audio:null,video:null},n=null,r=null,i=!1,a=()=>{r&&i&&n!==null&&t[r]===null&&Object.prototype.hasOwnProperty.call(t,r)&&(t[r]=n)};for(let t of e.split(/\r?\n/))t.startsWith(`m=`)?(a(),r=t.slice(2).split(` `)[0],n=null,i=!1):t.startsWith(`a=mid:`)?n=t.slice(6).trim():t.trim()===`a=recvonly`&&(i=!0);a();let o=this.peerConnection.getTransceivers(),s=e=>{if(e===null)return null;let t=o.find(t=>t.mid===e);if(t)try{t.direction=`sendonly`}catch{}return t||null};this._micTransceiver=s(t.audio),this._webcamTransceiver=s(t.video)}async setMicrophone(e,t=null){if(e){if(!this._micTransceiver)throw Error(`Microphone is disabled on this server.`);if(this._micStream||this._micPending)return!0;if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia)return!1;let e={channelCount:1,sampleRate:24e3,echoCancellation:!0,noiseSuppression:!0,autoGainControl:!0};t&&(e.deviceId={exact:t});let n=this._micPending={withdrawn:!1},r;try{r=await navigator.mediaDevices.getUserMedia({audio:e,video:!1})}finally{this._micPending=null}if(n.withdrawn)return r.getTracks().forEach(e=>e.stop()),null;this._micStream=r;let i=this._micStream.getAudioTracks()[0];return this._micTransceiver&&this._micTransceiver.sender&&i&&await this._micTransceiver.sender.replaceTrack(i),!0}if(this._micPending&&(this._micPending.withdrawn=!0),this._micTransceiver&&this._micTransceiver.sender)try{await this._micTransceiver.sender.replaceTrack(null)}catch{}return this._micStream&&=(this._micStream.getTracks().forEach(e=>e.stop()),null),!0}async setWebcam(e,t=null,{width:n=1280,height:r=720,fps:i=30,codec:a=`auto`}={}){if(e){if(!this._webcamTransceiver)throw Error(`Webcam is disabled on this server.`);if(this._webcamStream||this._webcamPending)return!0;if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia)return!1;let e={width:{ideal:n},height:{ideal:r},frameRate:{ideal:i}};t&&(e.deviceId={exact:t});let o=this._webcamPending={withdrawn:!1},s;try{s=await navigator.mediaDevices.getUserMedia({video:e,audio:!1})}finally{this._webcamPending=null}if(o.withdrawn)return s.getTracks().forEach(e=>e.stop()),null;let c=s.getVideoTracks()[0];try{c&&(await this._setSenderActive(this._webcamTransceiver.sender,!0),await this._webcamTransceiver.sender.replaceTrack(c))}catch(e){throw s.getTracks().forEach(e=>e.stop()),e}return this._webcamStream=s,await this.setWebcamCodec(a),!0}if(this._webcamPending&&(this._webcamPending.withdrawn=!0),this._webcamTransceiver&&this._webcamTransceiver.sender){await this._setSenderActive(this._webcamTransceiver.sender,!1);try{await this._webcamTransceiver.sender.replaceTrack(null)}catch{}}return this._webcamStream&&=(this._webcamStream.getTracks().forEach(e=>e.stop()),null),!0}async setWebcamCodec(e){let t=this._webcamTransceiver&&this._webcamTransceiver.sender;if(!t||!t.track)return!1;let n=`video/${String(e||`auto`).toLowerCase()}`;try{let e=t.getParameters();if(!e.encodings||e.encodings.length===0)return!1;let r=(e.codecs||[]).find(e=>e.mimeType.toLowerCase()===n)||null,i=e.encodings[0].codec||null;if(r){if(i&&i.mimeType.toLowerCase()===n)return!0;e.encodings[0].codec={mimeType:r.mimeType,clockRate:r.clockRate,sdpFmtpLine:r.sdpFmtpLine}}else{if(!i)return!1;delete e.encodings[0].codec}return await t.setParameters(e),!!r}catch(e){return console.warn(`Webcam codec not applied to the sender:`,e),!1}}async _setSenderActive(e,t){try{let n=e.getParameters();if(!n.encodings||n.encodings.length===0)return;let r=!1;n.encodings.forEach(e=>{e.active!==t&&(e.active=t,r=!0)}),r&&await e.setParameters(n)}catch(e){console.warn(`Sender encoding activation not applied:`,e)}}get webcamTrack(){return this._webcamStream&&this._webcamStream.getVideoTracks()[0]||null}_onLocalSDP(e){this._setDebug(`Created local SDP: `+JSON.stringify(e))}_ontrack(e){this._setStatus(`Received incoming `+e.track.kind+` stream from peer`),this.streams||=[],this.streams.push([e.track.kind,e.streams]),e.track.kind===`video`&&(this.element.srcObject=e.streams[0],this.playStream())}_onPeerdDataChannel(e){if(this._setStatus(`Peer data channel created: `+e.channel.label),e.channel.label===`pointer`){this._motion_channel=e.channel;return}this._send_channel=e.channel,this._send_channel.binaryType=`arraybuffer`,this._send_channel.onmessage=this._onPeerDataChannelMessage.bind(this),this._send_channel.onopen=()=>{typeof CompressionStream<`u`&&this._send_channel.send(`_gz,1`),this.ondatachannelopen!==null&&this.ondatachannelopen()},this._send_channel.onclose=()=>{this.ondatachannelclose!==null&&this.ondatachannelclose()},this._send_channel.onerror=e=>{this._setError(`Unexpected error, data channel closed, ${e.error||`unknown error`}`)}}_onPeerDataChannelMessage(e){if(e.data instanceof ArrayBuffer){let t=new Uint8Array(e.data,0,Math.min(2,e.data.byteLength));if(t[0]===31&&t[1]===139){let t=(async()=>{let t=await new Response(new Blob([e.data]).stream().pipeThrough(new DecompressionStream(`gzip`))).text(),n=this._parseDataChannelMessage(t);return n===null||this._requiresOrderedDelivery(n)?n:(this._routeDataChannelMessage(n),null)})().catch(e=>(this._setError(`failed to decompress data channel message: `+e),null));this._recvQueue=this._recvQueue.then(async()=>{let e=await t;if(e!==null)return this._routeDataChannelMessage(e)}).catch(e=>this._setError(`failed to handle data channel message: `+e));return}this._setError(`unexpected binary data channel message`);return}if(e.data===`_gz,1`){this._gzTx=!0;return}let t=this._parseDataChannelMessage(e.data);if(t!==null){if(!this._requiresOrderedDelivery(t)){try{this._routeDataChannelMessage(t)}catch(e){this._setError(`failed to handle data channel message: `+e)}return}this._recvQueue=this._recvQueue.then(()=>this._routeDataChannelMessage(t)).catch(e=>this._setError(`failed to handle data channel message: `+e))}}_requiresOrderedDelivery(e){return typeof e.type==`string`&&(e.type.startsWith(`clipboard-msg`)||e.type===`server_settings`||e.type===`display_settings`)}_parseDataChannelMessage(e){var t;try{t=JSON.parse(e)}catch(t){return t instanceof SyntaxError?this._setError(`error parsing data channel message as JSON: `+e):this._setError(`failed to parse data channel message: `+e),null}return this._setDebug(`data channel message: `+e),t}_routeDataChannelMessage(e){if(e.type===`pipeline`)this._setStatus(e.data.status);else if(e.type===`stream_info`)this.onstreaminfo!==null&&this.onstreaminfo(e.data);else if(e.type===`stream_stats`)this.onstreamstats!==null&&this.onstreamstats(e.data);else if(e.type===`connection`)this.onconnection!==null&&this.onconnection(!!(e.data&&e.data.poor));else if(typeof e.type==`string`&&e.type.startsWith(`clipboard-msg`)){if(typeof this.onclipboardcontent==`function`)return this.onclipboardcontent(e)}else if(e.type===`cursor`){if(this.oncursorchange!==null&&e.data!==null){let t={curdata:e.data.curdata,width:e.data.width,height:e.data.height,hotx:e.data.hotx,hoty:e.data.hoty,handle:e.data.handle};this._setDebug(`received new cursor contents, ${JSON.stringify(t)}`),this.oncursorchange(t)}}else if(e.type===`system`){if(e.data!=null&&e.data.action!=null){var t=e.data.action;this._setDebug(`received system msg, action: `+t),this.onsystemaction!==null&&this.onsystemaction(t)}}else e.type===`ping`?(this._setDebug(`received server ping: `+JSON.stringify(e.data)),this.sendDataChannelMessage(`pong,`+new Date().getTime()/1e3)):e.type===`latency_measurement`?this.onlatencymeasurement!==null&&this.onlatencymeasurement(e.data.latency_ms):e.type===`server_settings`?this.onserversettings!==null&&this.onserversettings(e.data):e.type===`display_settings`?this.ondisplaysettings!==null&&this.ondisplaysettings(e.data):e.type===`display_config_update`?this.ondisplayconfig!==null&&this.ondisplayconfig(e.data):e.type===`print_document`?this.onprintdocument!==null&&this.onprintdocument(e.data):e.type===`cc_rate`?this.onccrate!==null&&e.data&&this.onccrate(e.data.kbps):this._setError(`Unhandled message received: `+e.type)}_handleConnectionStateChange(e){switch(e){case`connected`:this._setStatus(`Connection complete`),this._connected=!0;break;case`disconnected`:this._setError(`Peer connection disconnected`),this._send_channel!==null&&this._send_channel.readyState===`open`&&this._send_channel.close(),this.element.load();break;case`failed`:this._setError(`Peer connection failed`),this.element.load()}}dataChannelBufferedAmount(){return this._send_channel&&this._send_channel.readyState===`open`?this._send_channel.bufferedAmount:0}dataChannelOpen(){return this._send_channel!==null&&this._send_channel.readyState===`open`}async waitForDataChannelDrain(e=1048576){if(this._sendQueue)try{await this._sendQueue}catch{}let t=this._send_channel;!t||t.readyState!==`open`||t.bufferedAmount<=e||(t.bufferedAmountLowThreshold=e,await new Promise(n=>{let r=()=>{t.removeEventListener(`bufferedamountlow`,r),n()};t.addEventListener(`bufferedamountlow`,r),(t.readyState!==`open`||t.bufferedAmount<=e)&&r()}))}motionBufferedAmount(){let e=this._motion_channel;return e!==null&&e.readyState===`open`?e.bufferedAmount:this.dataChannelBufferedAmount()}sendMotionMessage(e){let t=this._motion_channel;if(t!==null&&t.readyState===`open`){t.send(e);return}this.sendDataChannelMessage(e)}sendDataChannelMessage(e){if(this._send_channel!==null&&this._send_channel.readyState===`open`){if(!this._gzTx){this._send_channel.send(e);return}this._sendQueue=typeof e==`string`&&e.length>=512?this._sendQueue.then(async()=>{let t=await new Response(new Blob([e]).stream().pipeThrough(new CompressionStream(`gzip`))).arrayBuffer();this._send_channel&&this._send_channel.readyState===`open`&&this._send_channel.send(t)}).catch(()=>{}):this._sendQueue.then(()=>{this._send_channel&&this._send_channel.readyState===`open`&&this._send_channel.send(e)}).catch(()=>{})}}onGamepadDisconnect(e){this._setStatus(`gamepad: `+e+`, disconnected`)}getConnectionStats(){var e=this.peerConnection,t={general:{bytesReceived:0,bytesSent:0,connectionType:`NA`,currentRoundTripTime:null,availableReceiveBandwidth:0},video:{bytesReceived:0,decoder:`NA`,frameHeight:0,frameWidth:0,framesPerSecond:0,packetsReceived:0,packetsLost:0,codecName:`NA`,jitterBufferDelay:0,jitterBufferEmittedCount:0},audio:{bytesReceived:0,packetsReceived:0,packetsLost:0,codecName:`NA`,jitterBufferDelay:0,jitterBufferEmittedCount:0,concealedSamples:0,concealmentEvents:0,totalSamplesReceived:0,packetsDiscarded:0},data:{bytesReceived:0,bytesSent:0,messagesReceived:0,messagesSent:0}};return new Promise(function(n,r){e.getStats().then(e=>{var r={transports:{},candidatePairs:{},selectedCandidatePairId:null,remoteCandidates:{},localCandidates:{},outbound:{},codecs:{},videoRTP:null,videoTrack:null,audioRTP:null,audioTrack:null,dataChannel:null},i=[];e.forEach(e=>{i.push(e),e.type===`transport`?r.transports[e.id]=e:e.type===`candidate-pair`?(r.candidatePairs[e.id]=e,e.selected===!0&&(r.selectedCandidatePairId=e.id)):e.type===`inbound-rtp`?e.kind===`video`?r.videoRTP=e:e.kind===`audio`&&(r.audioRTP=e):e.type===`track`?e.kind===`video`?r.videoTrack=e:e.kind===`audio`&&(r.audioTrack=e):e.type===`data-channel`?r.dataChannel=e:e.type===`remote-candidate`?r.remoteCandidates[e.id]=e:e.type===`local-candidate`?r.localCandidates[e.id]=e:e.type===`outbound-rtp`?r.outbound[e.kind]=e:e.type===`codec`&&(r.codecs[e.id]=e)});var a=r.videoRTP;if(a!==null){t.video.bytesReceived=a.bytesReceived,t.video.decoder=a.decoderImplementation||`unknown`,t.video.frameHeight=a.frameHeight,t.video.frameWidth=a.frameWidth,t.video.framesPerSecond=a.framesPerSecond,t.video.packetsReceived=a.packetsReceived,t.video.packetsLost=a.packetsLost;let e=r.codecs[a.codecId];e!==void 0&&(t.video.codecName=e.mimeType.split(`/`)[1].toUpperCase())}var o=r.audioRTP;if(o!==null){t.audio.bytesReceived=o.bytesReceived,t.audio.packetsReceived=o.packetsReceived,t.audio.packetsLost=o.packetsLost,o.concealedSamples!==void 0&&(t.audio.concealedSamples=o.concealedSamples),o.concealmentEvents!==void 0&&(t.audio.concealmentEvents=o.concealmentEvents),o.totalSamplesReceived!==void 0&&(t.audio.totalSamplesReceived=o.totalSamplesReceived),o.packetsDiscarded!==void 0&&(t.audio.packetsDiscarded=o.packetsDiscarded);let e=r.codecs[o.codecId];e!==void 0&&(t.audio.codecName=e.mimeType.split(`/`)[1].toUpperCase())}var s=r.dataChannel;if(s!==null&&(t.data.bytesReceived=s.bytesReceived,t.data.bytesSent=s.bytesSent,t.data.messagesReceived=s.messagesReceived,t.data.messagesSent=s.messagesSent),Object.keys(r.transports).length>0){var c=r.transports[Object.keys(r.transports)[0]];t.general.bytesReceived=c.bytesReceived,t.general.bytesSent=c.bytesSent,r.selectedCandidatePairId=c.selectedCandidatePairId}else r.selectedCandidatePairId!==null&&(t.general.bytesReceived=r.candidatePairs[r.selectedCandidatePairId].bytesReceived,t.general.bytesSent=r.candidatePairs[r.selectedCandidatePairId].bytesSent);if(r.selectedCandidatePairId!==null){var l=r.candidatePairs[r.selectedCandidatePairId];if(l!==void 0){l.availableIncomingBitrate!==void 0&&(t.general.availableReceiveBandwidth=l.availableIncomingBitrate),l.currentRoundTripTime!==void 0&&(t.general.currentRoundTripTime=l.currentRoundTripTime);var u=r.remoteCandidates[l.remoteCandidateId];u!==void 0&&(t.general.connectionType=u.candidateType)}}t.general.packetsReceived=t.video.packetsReceived+t.audio.packetsReceived,t.general.packetsLost=t.video.packetsLost+t.audio.packetsLost,r.videoRTP!==null&&(t.video.jitterBufferDelay=r.videoRTP.jitterBufferDelay,t.video.jitterBufferEmittedCount=r.videoRTP.jitterBufferEmittedCount),r.audioRTP!==null&&(t.audio.jitterBufferDelay=r.audioRTP.jitterBufferDelay,t.audio.jitterBufferEmittedCount=r.audioRTP.jitterBufferEmittedCount),t.reports=r,t.allReports=i,n(t)}).catch(e=>r(e))})}playStream(){this.element.load();var e=this.element.play();e!==void 0&&e.then(()=>{this._setDebug(`Stream is playing.`)}).catch(()=>{this.onplaystreamrequired===null?this._setDebug(`Stream play failed and no onplaystreamrequired was bound.`):this.onplaystreamrequired()})}connect(){if(this.peerConnection=new RTCPeerConnection(this.rtcPeerConfig),this.peerConnection.ontrack=this._ontrack.bind(this),this.peerConnection.onicecandidate=this._onPeerICE.bind(this),this.peerConnection.ondatachannel=this._onPeerdDataChannel.bind(this),this.peerConnection.onconnectionstatechange=()=>{this._handleConnectionStateChange(this.peerConnection.connectionState),this._setConnectionState(this.peerConnection.connectionState)},this.forceTurn){this._setStatus(`forcing use of TURN server`);let e=this.peerConnection.getConfiguration();e.iceTransportPolicy=`relay`,this.peerConnection.setConfiguration(e)}this.signaling.peer_id=this.peer_id,this.signaling.connect()}reset(){this.cursor_cache=new Map;var e=this.peerConnection.signalingState;this._send_channel!==null&&this._send_channel.readyState===`open`&&this._send_channel.close(),this.peerConnection!==null&&this.peerConnection.close(),e===`stable`?this.connect():setTimeout(()=>{this.connect()},3e3)}};function ze(){return Array.from(crypto.getRandomValues(new Uint8Array(16)),e=>e.toString(16).padStart(2,`0`)).join(``)}var Be=400,Ve=1e3,He=class{constructor(e,t,n,r,i,a,o){this._server=e,this.capabilities=null,this.tenBitCapabilities=null,this.pageSize=null,this.peer_id=1,this._ws_conn=null,this.onstatus=null,this.onfatalretry=null,this.onerror=null,this.ondebug=null,this.onice=null,this.onsdp=null,this.ondisconnect=null,this.resumable=null,this.onresumed=null,this.resume_key=ze(),this._resuming=!1,this._resume_lines=[],this.state=`disconnected`,this.retry_count=0,this._retry_timer=null,this._backoff=0,this._forget_socket=()=>{},window.addEventListener(`online`,()=>{this._retry_timer&&(clearTimeout(this._retry_timer),this._retry_timer=null,this._backoff=0,this.retry_count--,this._scheduleRetry())}),this._intentional_close=!1,this.currRes=null,this.peer_type=`client`,this.client_type=t,this.server_peer_id=null,this.client_slot=n,this.client_strict_viewer=r,this.client_token=i,this.display_id=a||`primary`,this.display_position=o||`right`,this.onshowalert=null}_setStatus(e){this.onstatus!==null&&this.onstatus(e)}_setDebug(e){this.ondebug!==null&&this.ondebug(e)}_setError(e){this.onerror!==null&&this.onerror(e)}_setSDP(e){this.onsdp!==null&&this.onsdp(e)}_setICE(e){this.onice!==null&&this.onice(e)}async _onServerOpen(){this.state=`connected`;let e={client_type:this.client_type,client_slot:this.client_slot,client_strict_viewer:this.client_strict_viewer,client_token:this.client_token,display_id:this.display_id,display_position:this.display_position,client_tab_id:C(),cc_start_kbps:E(this.display_id),resume_key:this.resume_key};if(this.capabilities)try{e.fullcolor_codecs=await this.capabilities()}catch{}if(this.tenBitCapabilities)try{e.tenbit_codecs=await this.tenBitCapabilities()}catch{}if(this.pageSize)try{let t=this.pageSize();t&&(e.page_size=t)}catch{}this._ws_conn&&this._ws_conn.readyState===WebSocket.OPEN&&(this._ws_conn.send(`HELLO ${this.peer_type} ${JSON.stringify(e)}`),this._setStatus(`Registering with server, peer type: `+this.peer_type+`, client type: `+this.client_type),this.retry_count=0,this._backoff=0)}_scheduleRetry(){if(this._retry_timer)return;this.retry_count++;let e=Math.min(Be*2**this._backoff,Ve);this._backoff++,this._retry_timer=setTimeout(()=>{this._retry_timer=null,this.retry_count>3?this.onfatalretry===null?window.location.reload():this.onfatalretry():this.connect()},e)}retry(){this.retry_count=0,this._scheduleRetry()}_onServerError(){this._setStatus(`Connection error, retrying.`),this._ws_conn.readyState===this._ws_conn.CLOSED&&this._scheduleRetry()}_setupCall(){this._setStatus(`Initiating session with server.`),this._ws_conn.send(`SESSION server`)}_onServerMessage(e){if(this._setDebug(`server message: `+e.data),e.data===`HELLO`){if(this._resuming){this._setStatus(`Session not resumed; starting a new one.`),this.reconnect();return}this._setStatus(`Registered with server.`),this._setupCall();return}if(e.data.startsWith(`RESUMED `)){this._setStatus(`Session resumed.`),this.server_peer_id=e.data.split(` `)[1],this._resuming=!1;for(let e of this._resume_lines.splice(0))this._ws_conn.send(e);this.onresumed!==null&&this.onresumed();return}if(e.data.startsWith(`SESSION_OK`)){this._setStatus(`Session established with server.`),this.server_peer_id=e.data.split(` `)[1];return}if(e.data.startsWith(`ERROR`)){e.data===`ERROR peer server not found`&&(this._setError(`Server not found. Retrying...`),setTimeout(()=>{this._setupCall()},1e3));return}var t;try{t=e.data.substring(e.data.indexOf(` `)+1),t=JSON.parse(t)}catch(t){t instanceof SyntaxError?this._setError(`error parsing message as JSON: `+e.data):this._setError(`failed to parse message: `+e.data);return}if(t.sdp!=null)this._setSDP(new RTCSessionDescription(t.sdp));else if(t.ice!=null){var n=new RTCIceCandidate(t.ice);this._setICE(n)}else this._setError(`unhandled JSON message: `+t)}_onServerClose(e){if(this.state===`connecting`){this.state=`disconnected`,this._scheduleRetry();return}this.state=`disconnected`,this._setError(`Server closed connection.`);let t=this._intentional_close;this._intentional_close=!1,this.ondisconnect!==null&&(e.code===4e3?this.onshowalert!==null&&this.onshowalert(e.reason):e.code===4001?this.onshowalert!==null&&this.onshowalert(e.reason||`Session superseded by a new connection. Reload to take over.`):(e.code===1e3||e.code===1001)&&t?this.ondisconnect(!1):this.resumable!==null&&this.resumable()?(console.log(`Signaling socket cut; resuming the session.`),this._resuming=!0,this.connect()):(console.log(`Reconnecting due to server-side connection closure.`),this.resume_key=ze(),this.ondisconnect(!0)))}connect(){this.state=`connecting`,this._setStatus(`Connecting to server.`),this._ws_conn=new WebSocket(this._server);let e=!0;this._forget_socket=()=>{e=!1};let t=t=>n=>{e&&t.call(this,n)};this._ws_conn.addEventListener(`open`,t(this._onServerOpen)),this._ws_conn.addEventListener(`error`,t(this._onServerError)),this._ws_conn.addEventListener(`message`,t(this._onServerMessage)),this._ws_conn.addEventListener(`close`,t(this._onServerClose))}reconnect(){this._forget_socket(),this._retry_timer&&=(clearTimeout(this._retry_timer),null),this.resume_key=ze(),this._resuming=!1,this._resume_lines=[];try{this._ws_conn&&this._ws_conn.close()}catch{}this.state=`disconnected`,this.ondisconnect!==null&&this.ondisconnect(!0)}disconnect(){this._intentional_close=!0,this._ws_conn.close()}sendICE(e){this._setDebug(`sending ice candidate: `+JSON.stringify(e)),this._send(`${this.server_peer_id} ${JSON.stringify({ice:e})}`)}sendSDP(e){this._setDebug(`sending local sdp: `+JSON.stringify(e)),this._send(`${this.server_peer_id} ${JSON.stringify({sdp:e})}`)}_send(e){this._resuming?this._resume_lines.push(e):this._ws_conn.send(e)}},Ue={buttons:{a:0,b:1,x:2,y:3,leftshoulder:4,rightshoulder:5,lefttrigger:6,righttrigger:7,back:8,start:9,leftstick:10,rightstick:11,dpup:12,dpdown:13,dpleft:14,dpright:15,guide:16},axes:{leftx:0,lefty:1,rightx:2,righty:3}},We=4,Ge=.05,Ke=[[0,1],[2,3]],k=.5,qe=24,Je=()=>({12:!1,13:!1,14:!1,15:!1}),Ye=5e3,Xe=(()=>{let e=typeof navigator<`u`&&navigator.userAgent||``;return/iPhone|iPad|iPod/i.test(e)?`ios`:/Android/i.test(e)?`android`:/Windows/i.test(e)?`windows`:/Macintosh|Mac OS X/i.test(e)?`mac`:`linux`})(),Ze=class{constructor(e,t,n,r,i){this.gamepad=e,this.onButton=t,this.onAxis=n,this.onHeld=r||null,this.onActive=i||null,this.drivers=[null],this._takenUpAt={},this._usedAt={},this._tick=0,this._lastHeldBeat=0,this.state={},this._active=!0,this.interval=setInterval(()=>{this._poll()},4),this._onTouchInput=()=>this._poll(),window.addEventListener(`touchgamepadinput`,this._onTouchInput),this.rumbleEnabled=!0,this._rumbling={}}get active(){return this.drivers[0]}setSlotCount(e){let t=Math.max(1,e|0);for(;this.drivers.length>t;){let e=this.drivers.length-1;this.drivers[e]!==null&&this._setDriver(e,null,null),this.drivers.pop()}for(;this.drivers.length<t;)this.drivers.push(null)}drivenPosition(e){return this.drivers.indexOf(e)}enable(){this._active||(this._active=!0,console.log(`GamepadManager polling activated.`))}disable(){this._active&&(this._active=!1,this.stopRumble(),console.log(`GamepadManager polling deactivated.`))}async _loadRemapProfile(e,t){t.loadingProfile=!0;let n=`jsdb/${Xe}/${e}.json`;try{console.log(`Attempting to load mapping for ${e} from ${n}`);let r=await fetch(n);if(!r.ok){r.status===404?console.log(`No custom mapping file found for ${e}. Using browser default.`):console.warn(`Failed to load mapping for ${e} (HTTP Status: ${r.status})`),t.remapProfile=null;return}let i=await r.json();console.log(`Successfully loaded and applying custom mapping for: ${e}`);let a={buttons:{},axes:{}};for(let e in i){let t=i[e];if(t.type===`button`){let n=Ue.buttons[e];n!==void 0&&(a.buttons[t.index]=n)}else if(t.type===`axis`){let n=Ue.axes[e];n!==void 0&&(a.axes[t.index]=n)}}t.remapProfile=a}catch(n){console.error(`Error fetching or parsing mapping file for ${e}:`,n),t.remapProfile=null}}_poll(){if(!this._active)return;let e=navigator.getGamepads();this._choose(e);for(let t=0;t<We;t++){let n=e[t];if(n){let e=this.state[t];if(!e&&(e=this.state[t]={axes:Array(n.axes.length).fill(0),buttons:Array(n.buttons.length).fill(0),dpadAxisState:Je(),remapProfile:null,loadingProfile:!1},n.mapping!==`standard`)){let t=n.id.match(/Vendor: ([0-9a-f]{4}) Product: ([0-9a-f]{4})/i);if(t&&!e.loadingProfile){let n=`${t[1].toLowerCase()}-${t[2].toLowerCase()}`;this._loadRemapProfile(n,e)}}if(this.drivers.indexOf(t)<0)continue;e.buttons.length!==n.buttons.length&&(e.buttons=Array(n.buttons.length).fill(0)),e.axes.length!==n.axes.length&&(e.axes=Array(n.axes.length).fill(0));for(let r=0;r<n.buttons.length;r++){if(n.buttons[r]===void 0)continue;let i=n.buttons[r].value,a=n.buttons[r].pressed,o=r;if(n.mapping!==`standard`&&navigator.userAgent.includes(`Firefox`)&&(r===2?o=3:r===3&&(o=2)),e.buttons[r]!==i){if(e.remapProfile){let t=e.remapProfile.buttons[o];if(t!==void 0)o=t;else continue}this.onButton(t,o,i,a),e.buttons[r]=i}}let r=this._deadzone(n,e);for(let i=0;i<n.axes.length;i++){if(n.axes[i]===void 0)continue;let a=r[i];if(e.axes[i]!==a){if(n.mapping===`standard`||i!==4&&i!==5){let n=i;e.remapProfile&&e.remapProfile.axes[i]!==void 0&&(n=e.remapProfile.axes[i]),this.onAxis(t,n,a)}e.axes[i]=a}}if(n.mapping!==`standard`&&n.axes.length>=6){let r=.5,i={up:n.axes[5]<-.5,down:n.axes[5]>r,left:n.axes[4]<-.5,right:n.axes[4]>r};i.up!==e.dpadAxisState[12]&&(this.onButton(t,12,+!!i.up,i.up),e.dpadAxisState[12]=i.up),i.down!==e.dpadAxisState[13]&&(this.onButton(t,13,+!!i.down,i.down),e.dpadAxisState[13]=i.down),i.left!==e.dpadAxisState[14]&&(this.onButton(t,14,+!!i.left,i.left),e.dpadAxisState[14]=i.left),i.right!==e.dpadAxisState[15]&&(this.onButton(t,15,+!!i.right,i.right),e.dpadAxisState[15]=i.right)}}else this.state[t]&&delete this.state[t]}if(this.onHeld&&this._anyHeld()){let e=Date.now();e-this._lastHeldBeat>=100&&(this._lastHeldBeat=e,this.onHeld())}}_choose(e){this._tick++;let t=[],n=[];for(let r=0;r<We;r++){let i=e[r];if(!i){delete this._takenUpAt[r],delete this._usedAt[r];continue}t.push(r);let a=this._takenUp(i);a&~(this._takenUpAt[r]||0)&&(this._usedAt[r]=this._tick,this.drivers.indexOf(r)<0&&n.push(r)),this._takenUpAt[r]=a}for(let t=0;t<this.drivers.length;t++){let n=this.drivers[t];n!==null&&!e[n]&&this._setDriver(t,null,null)}let r=t.length<=this.drivers.length?t.filter(e=>this.drivers.indexOf(e)<0):n,i=new Set;for(let t of r){let n=this.drivers.indexOf(null);if(n<0){let e=1/0;for(let t=0;t<this.drivers.length;t++){let r=this._usedAt[this.drivers[t]]||0;!i.has(t)&&r<e&&(e=r,n=t)}}if(n<0)break;i.add(n),this._setDriver(n,t,e[t])}}_takenUp(e){let t=0;for(let n=0;n<e.buttons.length&&n<qe;n++){let r=e.buttons[n];r&&r.value>=k&&(t|=1<<n)}if(e.mapping===`standard`)for(let n=0;n<4&&n<e.axes.length;n++)Math.abs(e.axes[n]||0)>=k&&(t|=1<<qe+n);return t}_setDriver(e,t,n){let r=this.drivers[e],i=r!==null;for(let e of[r,t])this._unreport(e);this.drivers[e]=t,this.onActive&&this.onActive(n,i,e)}_unreport(e){let t=e===null?null:this.state[e];t&&(t.buttons.fill(0),t.axes.fill(0),t.dpadAxisState=Je())}padGone(e){delete this._takenUpAt[e],delete this._usedAt[e],delete this.state[e];let t=this.drivers.indexOf(e);t>=0&&this._setDriver(t,null,null)}reannounce(){let e;try{e=navigator.getGamepads()}catch{return}for(let t=0;t<this.drivers.length;t++){let n=this.drivers[t],r=n===null?null:e[n];r&&(this._unreport(n),this.onActive&&this.onActive(r,!1,t))}}_deadzone(e,t){let n=t.deadzoned||=[];n.length=e.axes.length;for(let t=0;t<e.axes.length;t++){let r=e.axes[t];n[t]=r===void 0||Math.abs(r)<Ge?0:r}for(let[r,i]of Ke){let a=this._rawAxis(e,t,r),o=this._rawAxis(e,t,i);if(a<0||o<0)continue;let s=Math.hypot(e.axes[a]||0,e.axes[o]||0)<Ge;n[a]=s?0:e.axes[a]||0,n[o]=s?0:e.axes[o]||0}return n}_rawAxis(e,t,n){if(e.mapping===`standard`)return n<e.axes.length?n:-1;if(!t.remapProfile)return-1;for(let e in t.remapProfile.axes)if(t.remapProfile.axes[e]===n)return Number(e);return-1}_anyHeld(){for(let e in this.state){let t=this.state[e];if(t.buttons.some(e=>e!==0)||t.axes.some(e=>e!==0))return!0}return!1}rumble(e,t,n,r=null){let i=!(e>0||t>0)||!this.rumbleEnabled||!this._active,a=r===null?`all`:r;if(i&&!this._rumbling[a])return;this._rumbling[a]=!i,n=Math.min(Ye,Math.max(0,n||0));let o;try{o=Array.from(navigator.getGamepads())}catch{return}for(let a of o){if(!a||!a.connected||r!==null&&a.index!==r)continue;let o=a.vibrationActuator;if(o&&typeof o.playEffect==`function`){let r=i&&typeof o.reset==`function`?o.reset():o.playEffect(`dual-rumble`,{startDelay:0,duration:i?0:n,strongMagnitude:i?0:e,weakMagnitude:i?0:t});r&&typeof r.catch==`function`&&r.catch(()=>{});continue}let s=a.hapticActuators&&a.hapticActuators[0];if(s&&typeof s.pulse==`function`){let r=s.pulse(i?0:Math.max(e,t),i?0:n);r&&typeof r.catch==`function`&&r.catch(()=>{})}}}stopRumble(){for(let e of Object.keys(this._rumbling))this.rumble(0,0,0,e===`all`?null:Number(e))}setRumbleEnabled(e){this.rumbleEnabled=!!e,this.rumbleEnabled||this.stopRumble()}destroy(){this.stopRumble(),clearInterval(this.interval),window.removeEventListener(`touchgamepadinput`,this._onTouchInput),this.state={},console.log(`GamepadManager destroyed.`)}};function A(e){"@babel/helpers - typeof";return A=typeof Symbol==`function`&&typeof Symbol.iterator==`symbol`?function(e){return typeof e}:function(e){return e&&typeof Symbol==`function`&&e.constructor===Symbol&&e!==Symbol.prototype?`symbol`:typeof e},A(e)}function Qe(e,t){if(A(e)!=`object`||!e)return e;var n=e[Symbol.toPrimitive];if(n!==void 0){var r=n.call(e,t||`default`);if(A(r)!=`object`)return r;throw TypeError(`@@toPrimitive must return a primitive value.`)}return(t===`string`?String:Number)(e)}function $e(e){var t=Qe(e,`string`);return A(t)==`symbol`?t:t+``}function et(e,t,n){return(t=$e(t))in e?Object.defineProperty(e,t,{value:n,enumerable:!0,configurable:!0,writable:!0}):e[t]=n,e}var j=`allow-native-input`,tt=2,nt=16384,rt=30,it=180,at=200,ot=.15,M=25,st=.25,ct=4,N=80,lt=40,ut=120,dt=200,ft=2e3,pt=256;function mt(e){let t=Math.min(1,Math.max(0,(e-ot)/1.05));return 1+2*t*t*(3-2*t)}function ht(e){let t=(Array.isArray(e)?e:e==null?[]:[e]).map(Number).filter(e=>Number.isInteger(e)&&e>=1);return t.length?t:null}var gt=50,_t=10,vt=1.14,yt=40;function bt(e){return e&-7|(e&2)<<1|(e&4)>>1}var xt={ShiftLeft:`Shift`,ShiftRight:`Shift`,ControlLeft:`Control`,ControlRight:`Control`,AltLeft:`Alt`,AltRight:`Alt`,MetaLeft:`Meta`,MetaRight:`Meta`};function St(e){return!!e.altKey||typeof e.getModifierState==`function`&&e.getModifierState(`AltGraph`)}function Ct(e,t){return t?t===`Alt`?St(e):e.getModifierState(t):!1}function wt(e){if(typeof e!=`string`||[...e].length!==1)return!1;let t=e.codePointAt(0);return t>=32&&t!==127}function Tt(e){return e.isTrusted!==!1||e.__selkiesClipReplay===!0}var P={XK_VoidSymbol:16777215,XK_BackSpace:65288,XK_Tab:65289,XK_Linefeed:65290,XK_Clear:65291,XK_Return:65293,XK_Pause:65299,XK_Scroll_Lock:65300,XK_Sys_Req:65301,XK_Escape:65307,XK_Delete:65535,XK_Multi_key:65312,XK_Codeinput:65335,XK_SingleCandidate:65340,XK_MultipleCandidate:65341,XK_PreviousCandidate:65342,XK_Kanji:65313,XK_Muhenkan:65314,XK_Henkan_Mode:65315,XK_Henkan:65315,XK_Romaji:65316,XK_Hiragana:65317,XK_Katakana:65318,XK_Hiragana_Katakana:65319,XK_Zenkaku:65320,XK_Hankaku:65321,XK_Zenkaku_Hankaku:65322,XK_Touroku:65323,XK_Massyo:65324,XK_Kana_Lock:65325,XK_Kana_Shift:65326,XK_Eisu_Shift:65327,XK_Eisu_toggle:65328,XK_Kanji_Bangou:65335,XK_Zen_Koho:65341,XK_Mae_Koho:65342,XK_Home:65360,XK_Left:65361,XK_Up:65362,XK_Right:65363,XK_Down:65364,XK_Prior:65365,XK_Page_Up:65365,XK_Next:65366,XK_Page_Down:65366,XK_End:65367,XK_Begin:65368,XK_Select:65376,XK_Print:65377,XK_Execute:65378,XK_Insert:65379,XK_Undo:65381,XK_Redo:65382,XK_Menu:65383,XK_Find:65384,XK_Cancel:65385,XK_Help:65386,XK_Break:65387,XK_Mode_switch:65406,XK_script_switch:65406,XK_Num_Lock:65407,XK_KP_Space:65408,XK_KP_Tab:65417,XK_KP_Enter:65421,XK_KP_F1:65425,XK_KP_F2:65426,XK_KP_F3:65427,XK_KP_F4:65428,XK_KP_Home:65429,XK_KP_Left:65430,XK_KP_Up:65431,XK_KP_Right:65432,XK_KP_Down:65433,XK_KP_Prior:65434,XK_KP_Page_Up:65434,XK_KP_Next:65435,XK_KP_Page_Down:65435,XK_KP_End:65436,XK_KP_Begin:65437,XK_KP_Insert:65438,XK_KP_Delete:65439,XK_KP_Equal:65469,XK_KP_Multiply:65450,XK_KP_Add:65451,XK_KP_Separator:65452,XK_KP_Subtract:65453,XK_KP_Decimal:65454,XK_KP_Divide:65455,XK_KP_0:65456,XK_KP_1:65457,XK_KP_2:65458,XK_KP_3:65459,XK_KP_4:65460,XK_KP_5:65461,XK_KP_6:65462,XK_KP_7:65463,XK_KP_8:65464,XK_KP_9:65465,XK_F1:65470,XK_F2:65471,XK_F3:65472,XK_F4:65473,XK_F5:65474,XK_F6:65475,XK_F7:65476,XK_F8:65477,XK_F9:65478,XK_F10:65479,XK_F11:65480,XK_L1:65480,XK_F12:65481,XK_L2:65481,XK_F13:65482,XK_L3:65482,XK_F14:65483,XK_L4:65483,XK_F15:65484,XK_L5:65484,XK_F16:65485,XK_L6:65485,XK_F17:65486,XK_L7:65486,XK_F18:65487,XK_L8:65487,XK_F19:65488,XK_L9:65488,XK_F20:65489,XK_L10:65489,XK_F21:65490,XK_R1:65490,XK_F22:65491,XK_R2:65491,XK_F23:65492,XK_R3:65492,XK_F24:65493,XK_R4:65493,XK_F25:65494,XK_R5:65494,XK_F26:65495,XK_R6:65495,XK_F27:65496,XK_R7:65496,XK_F28:65497,XK_R8:65497,XK_F29:65498,XK_R9:65498,XK_F30:65499,XK_R10:65499,XK_F31:65500,XK_R11:65500,XK_F32:65501,XK_R12:65501,XK_F33:65502,XK_R13:65502,XK_F34:65503,XK_R14:65503,XK_F35:65504,XK_R15:65504,XK_Shift_L:65505,XK_Shift_R:65506,XK_Control_L:65507,XK_Control_R:65508,XK_Caps_Lock:65509,XK_Shift_Lock:65510,XK_Meta_L:65511,XK_Meta_R:65512,XK_Alt_L:65513,XK_Alt_R:65514,XK_Super_L:65515,XK_Super_R:65516,XK_Hyper_L:65517,XK_Hyper_R:65518,XK_ISO_Level3_Shift:65027,XK_ISO_Next_Group:65032,XK_ISO_Prev_Group:65034,XK_ISO_First_Group:65036,XK_ISO_Last_Group:65038,XK_space:32,XK_exclam:33,XK_quotedbl:34,XK_numbersign:35,XK_dollar:36,XK_percent:37,XK_ampersand:38,XK_apostrophe:39,XK_quoteright:39,XK_parenleft:40,XK_parenright:41,XK_asterisk:42,XK_plus:43,XK_comma:44,XK_minus:45,XK_period:46,XK_slash:47,XK_0:48,XK_1:49,XK_2:50,XK_3:51,XK_4:52,XK_5:53,XK_6:54,XK_7:55,XK_8:56,XK_9:57,XK_colon:58,XK_semicolon:59,XK_less:60,XK_equal:61,XK_greater:62,XK_question:63,XK_at:64,XK_A:65,XK_B:66,XK_C:67,XK_D:68,XK_E:69,XK_F:70,XK_G:71,XK_H:72,XK_I:73,XK_J:74,XK_K:75,XK_L:76,XK_M:77,XK_N:78,XK_O:79,XK_P:80,XK_Q:81,XK_R:82,XK_S:83,XK_T:84,XK_U:85,XK_V:86,XK_W:87,XK_X:88,XK_Y:89,XK_Z:90,XK_bracketleft:91,XK_backslash:92,XK_bracketright:93,XK_asciicircum:94,XK_underscore:95,XK_grave:96,XK_quoteleft:96,XK_a:97,XK_b:98,XK_c:99,XK_d:100,XK_e:101,XK_f:102,XK_g:103,XK_h:104,XK_i:105,XK_j:106,XK_k:107,XK_l:108,XK_m:109,XK_n:110,XK_o:111,XK_p:112,XK_q:113,XK_r:114,XK_s:115,XK_t:116,XK_u:117,XK_v:118,XK_w:119,XK_x:120,XK_y:121,XK_z:122,XK_braceleft:123,XK_bar:124,XK_braceright:125,XK_asciitilde:126,XK_nobreakspace:160,XK_exclamdown:161,XK_cent:162,XK_sterling:163,XK_currency:164,XK_yen:165,XK_brokenbar:166,XK_section:167,XK_diaeresis:168,XK_copyright:169,XK_ordfeminine:170,XK_guillemotleft:171,XK_notsign:172,XK_hyphen:173,XK_registered:174,XK_macron:175,XK_degree:176,XK_plusminus:177,XK_twosuperior:178,XK_threesuperior:179,XK_acute:180,XK_mu:181,XK_paragraph:182,XK_periodcentered:183,XK_cedilla:184,XK_onesuperior:185,XK_masculine:186,XK_guillemotright:187,XK_onequarter:188,XK_onehalf:189,XK_threequarters:190,XK_questiondown:191,XK_Agrave:192,XK_Aacute:193,XK_Acircumflex:194,XK_Atilde:195,XK_Adiaeresis:196,XK_Aring:197,XK_AE:198,XK_Ccedilla:199,XK_Egrave:200,XK_Eacute:201,XK_Ecircumflex:202,XK_Ediaeresis:203,XK_Igrave:204,XK_Iacute:205,XK_Icircumflex:206,XK_Idiaeresis:207,XK_ETH:208,XK_Eth:208,XK_Ntilde:209,XK_Ograve:210,XK_Oacute:211,XK_Ocircumflex:212,XK_Otilde:213,XK_Odiaeresis:214,XK_multiply:215,XK_Oslash:216,XK_Ooblique:216,XK_Ugrave:217,XK_Uacute:218,XK_Ucircumflex:219,XK_Udiaeresis:220,XK_Yacute:221,XK_THORN:222,XK_Thorn:222,XK_ssharp:223,XK_agrave:224,XK_aacute:225,XK_acircumflex:226,XK_atilde:227,XK_adiaeresis:228,XK_aring:229,XK_ae:230,XK_ccedilla:231,XK_egrave:232,XK_eacute:233,XK_ecircumflex:234,XK_ediaeresis:235,XK_igrave:236,XK_iacute:237,XK_icircumflex:238,XK_idiaeresis:239,XK_eth:240,XK_ntilde:241,XK_ograve:242,XK_oacute:243,XK_ocircumflex:244,XK_otilde:245,XK_odiaeresis:246,XK_division:247,XK_oslash:248,XK_ooblique:248,XK_ugrave:249,XK_uacute:250,XK_ucircumflex:251,XK_udiaeresis:252,XK_yacute:253,XK_thorn:254,XK_ydiaeresis:255,XK_Hangul:65329,XK_Hangul_Hanja:65332,XK_Hangul_Jeonja:65336,XF86XK_ModeLock:269025025,XF86XK_MonBrightnessUp:269025026,XF86XK_MonBrightnessDown:269025027,XF86XK_KbdLightOnOff:269025028,XF86XK_KbdBrightnessUp:269025029,XF86XK_KbdBrightnessDown:269025030,XF86XK_Standby:269025040,XF86XK_AudioLowerVolume:269025041,XF86XK_AudioMute:269025042,XF86XK_AudioRaiseVolume:269025043,XF86XK_AudioPlay:269025044,XF86XK_AudioStop:269025045,XF86XK_AudioPrev:269025046,XF86XK_AudioNext:269025047,XF86XK_HomePage:269025048,XF86XK_Mail:269025049,XF86XK_Start:269025050,XF86XK_Search:269025051,XF86XK_AudioRecord:269025052,XF86XK_Calculator:269025053,XF86XK_Memo:269025054,XF86XK_ToDoList:269025055,XF86XK_Calendar:269025056,XF86XK_PowerDown:269025057,XF86XK_ContrastAdjust:269025058,XF86XK_RockerUp:269025059,XF86XK_RockerDown:269025060,XF86XK_RockerEnter:269025061,XF86XK_Back:269025062,XF86XK_Forward:269025063,XF86XK_Stop:269025064,XF86XK_Refresh:269025065,XF86XK_PowerOff:269025066,XF86XK_WakeUp:269025067,XF86XK_Eject:269025068,XF86XK_ScreenSaver:269025069,XF86XK_WWW:269025070,XF86XK_Sleep:269025071,XF86XK_Favorites:269025072,XF86XK_AudioPause:269025073,XF86XK_AudioMedia:269025074,XF86XK_MyComputer:269025075,XF86XK_VendorHome:269025076,XF86XK_LightBulb:269025077,XF86XK_Shop:269025078,XF86XK_History:269025079,XF86XK_OpenURL:269025080,XF86XK_AddFavorite:269025081,XF86XK_HotLinks:269025082,XF86XK_BrightnessAdjust:269025083,XF86XK_Finance:269025084,XF86XK_Community:269025085,XF86XK_AudioRewind:269025086,XF86XK_BackForward:269025087,XF86XK_Launch0:269025088,XF86XK_Launch1:269025089,XF86XK_Launch2:269025090,XF86XK_Launch3:269025091,XF86XK_Launch4:269025092,XF86XK_Launch5:269025093,XF86XK_Launch6:269025094,XF86XK_Launch7:269025095,XF86XK_Launch8:269025096,XF86XK_Launch9:269025097,XF86XK_LaunchA:269025098,XF86XK_LaunchB:269025099,XF86XK_LaunchC:269025100,XF86XK_LaunchD:269025101,XF86XK_LaunchE:269025102,XF86XK_LaunchF:269025103,XF86XK_ApplicationLeft:269025104,XF86XK_ApplicationRight:269025105,XF86XK_Book:269025106,XF86XK_CD:269025107,XF86XK_Calculater:269025108,XF86XK_Clear:269025109,XF86XK_Close:269025110,XF86XK_Copy:269025111,XF86XK_Cut:269025112,XF86XK_Display:269025113,XF86XK_DOS:269025114,XF86XK_Documents:269025115,XF86XK_Excel:269025116,XF86XK_Explorer:269025117,XF86XK_Game:269025118,XF86XK_Go:269025119,XF86XK_iTouch:269025120,XF86XK_LogOff:269025121,XF86XK_Market:269025122,XF86XK_Meeting:269025123,XF86XK_MenuKB:269025125,XF86XK_MenuPB:269025126,XF86XK_MySites:269025127,XF86XK_New:269025128,XF86XK_News:269025129,XF86XK_OfficeHome:269025130,XF86XK_Open:269025131,XF86XK_Option:269025132,XF86XK_Paste:269025133,XF86XK_Phone:269025134,XF86XK_Q:269025136,XF86XK_Reply:269025138,XF86XK_Reload:269025139,XF86XK_RotateWindows:269025140,XF86XK_RotationPB:269025141,XF86XK_RotationKB:269025142,XF86XK_Save:269025143,XF86XK_ScrollUp:269025144,XF86XK_ScrollDown:269025145,XF86XK_ScrollClick:269025146,XF86XK_Send:269025147,XF86XK_Spell:269025148,XF86XK_SplitScreen:269025149,XF86XK_Support:269025150,XF86XK_TaskPane:269025151,XF86XK_Terminal:269025152,XF86XK_Tools:269025153,XF86XK_Travel:269025154,XF86XK_UserPB:269025156,XF86XK_User1KB:269025157,XF86XK_User2KB:269025158,XF86XK_Video:269025159,XF86XK_WheelButton:269025160,XF86XK_Word:269025161,XF86XK_Xfer:269025162,XF86XK_ZoomIn:269025163,XF86XK_ZoomOut:269025164,XF86XK_Away:269025165,XF86XK_Messenger:269025166,XF86XK_WebCam:269025167,XF86XK_MailForward:269025168,XF86XK_Pictures:269025169,XF86XK_Music:269025170,XF86XK_Battery:269025171,XF86XK_Bluetooth:269025172,XF86XK_WLAN:269025173,XF86XK_UWB:269025174,XF86XK_AudioForward:269025175,XF86XK_AudioRepeat:269025176,XF86XK_AudioRandomPlay:269025177,XF86XK_Subtitle:269025178,XF86XK_AudioCycleTrack:269025179,XF86XK_CycleAngle:269025180,XF86XK_FrameBack:269025181,XF86XK_FrameForward:269025182,XF86XK_Time:269025183,XF86XK_Select:269025184,XF86XK_View:269025185,XF86XK_TopMenu:269025186,XF86XK_Red:269025187,XF86XK_Green:269025188,XF86XK_Yellow:269025189,XF86XK_Blue:269025190,XF86XK_Suspend:269025191,XF86XK_Hibernate:269025192,XF86XK_TouchpadToggle:269025193,XF86XK_TouchpadOn:269025200,XF86XK_TouchpadOff:269025201,XF86XK_AudioMicMute:269025202,XF86XK_Switch_VT_1:269024769,XF86XK_Switch_VT_2:269024770,XF86XK_Switch_VT_3:269024771,XF86XK_Switch_VT_4:269024772,XF86XK_Switch_VT_5:269024773,XF86XK_Switch_VT_6:269024774,XF86XK_Switch_VT_7:269024775,XF86XK_Switch_VT_8:269024776,XF86XK_Switch_VT_9:269024777,XF86XK_Switch_VT_10:269024778,XF86XK_Switch_VT_11:269024779,XF86XK_Switch_VT_12:269024780,XF86XK_Ungrab:269024800,XF86XK_ClearGrab:269024801,XF86XK_Next_VMode:269024802,XF86XK_Prev_VMode:269024803,XF86XK_LogWindowTree:269024804,XF86XK_LogGrabInfo:269024805},Et={256:960,257:992,258:451,259:483,260:417,261:433,262:454,263:486,264:710,265:742,266:709,267:741,268:456,269:488,270:463,271:495,272:464,273:496,274:938,275:954,278:972,279:1004,280:458,281:490,282:460,283:492,284:728,285:760,286:683,287:699,288:725,289:757,290:939,291:955,292:678,293:694,294:673,295:689,296:933,297:949,298:975,299:1007,302:967,303:999,304:681,305:697,308:684,309:700,310:979,311:1011,312:930,313:453,314:485,315:934,316:950,317:421,318:437,321:419,322:435,323:465,324:497,325:977,326:1009,327:466,328:498,330:957,331:959,332:978,333:1010,336:469,337:501,338:5052,339:5053,340:448,341:480,342:931,343:947,344:472,345:504,346:422,347:438,348:734,349:766,350:426,351:442,352:425,353:441,354:478,355:510,356:427,357:443,358:940,359:956,360:989,361:1021,362:990,363:1022,364:733,365:765,366:473,367:505,368:475,369:507,370:985,371:1017,376:5054,377:428,378:444,379:431,380:447,381:430,382:446,402:2294,466:16777681,711:439,728:418,729:511,731:434,733:445,901:1966,902:1953,904:1954,905:1955,906:1956,908:1959,910:1960,911:1963,912:1974,913:1985,914:1986,915:1987,916:1988,917:1989,918:1990,919:1991,920:1992,921:1993,922:1994,923:1995,924:1996,925:1997,926:1998,927:1999,928:2e3,929:2001,931:2002,932:2004,933:2005,934:2006,935:2007,936:2008,937:2009,938:1957,939:1961,940:1969,941:1970,942:1971,943:1972,944:1978,945:2017,946:2018,947:2019,948:2020,949:2021,950:2022,951:2023,952:2024,953:2025,954:2026,955:2027,956:2028,957:2029,958:2030,959:2031,960:2032,961:2033,962:2035,963:2034,964:2036,965:2037,966:2038,967:2039,968:2040,969:2041,970:1973,971:1977,972:1975,973:1976,974:1979,1025:1715,1026:1713,1027:1714,1028:1716,1029:1717,1030:1718,1031:1719,1032:1720,1033:1721,1034:1722,1035:1723,1036:1724,1038:1726,1039:1727,1040:1761,1041:1762,1042:1783,1043:1767,1044:1764,1045:1765,1046:1782,1047:1786,1048:1769,1049:1770,1050:1771,1051:1772,1052:1773,1053:1774,1054:1775,1055:1776,1056:1778,1057:1779,1058:1780,1059:1781,1060:1766,1061:1768,1062:1763,1063:1790,1064:1787,1065:1789,1066:1791,1067:1785,1068:1784,1069:1788,1070:1760,1071:1777,1072:1729,1073:1730,1074:1751,1075:1735,1076:1732,1077:1733,1078:1750,1079:1754,1080:1737,1081:1738,1082:1739,1083:1740,1084:1741,1085:1742,1086:1743,1087:1744,1088:1746,1089:1747,1090:1748,1091:1749,1092:1734,1093:1736,1094:1731,1095:1758,1096:1755,1097:1757,1098:1759,1099:1753,1100:1752,1101:1756,1102:1728,1103:1745,1105:1699,1106:1697,1107:1698,1108:1700,1109:1701,1110:1702,1111:1703,1112:1704,1113:1705,1114:1706,1115:1707,1116:1708,1118:1710,1119:1711,1168:1725,1169:1709,1488:3296,1489:3297,1490:3298,1491:3299,1492:3300,1493:3301,1494:3302,1495:3303,1496:3304,1497:3305,1498:3306,1499:3307,1500:3308,1501:3309,1502:3310,1503:3311,1504:3312,1505:3313,1506:3314,1507:3315,1508:3316,1509:3317,1510:3318,1511:3319,1512:3320,1513:3321,1514:3322,1548:1452,1563:1467,1567:1471,1569:1473,1570:1474,1571:1475,1572:1476,1573:1477,1574:1478,1575:1479,1576:1480,1577:1481,1578:1482,1579:1483,1580:1484,1581:1485,1582:1486,1583:1487,1584:1488,1585:1489,1586:1490,1587:1491,1588:1492,1589:1493,1590:1494,1591:1495,1592:1496,1593:1497,1594:1498,1600:1504,1601:1505,1602:1506,1603:1507,1604:1508,1605:1509,1606:1510,1607:1511,1608:1512,1609:1513,1610:1514,1611:1515,1612:1516,1613:1517,1614:1518,1615:1519,1616:1520,1617:1521,1618:1522,3585:3489,3586:3490,3587:3491,3588:3492,3589:3493,3590:3494,3591:3495,3592:3496,3593:3497,3594:3498,3595:3499,3596:3500,3597:3501,3598:3502,3599:3503,3600:3504,3601:3505,3602:3506,3603:3507,3604:3508,3605:3509,3606:3510,3607:3511,3608:3512,3609:3513,3610:3514,3611:3515,3612:3516,3613:3517,3614:3518,3615:3519,3616:3520,3617:3521,3618:3522,3619:3523,3620:3524,3621:3525,3622:3526,3623:3527,3624:3528,3625:3529,3626:3530,3627:3531,3628:3532,3629:3533,3630:3534,3631:3535,3632:3536,3633:3537,3634:3538,3635:3539,3636:3540,3637:3541,3638:3542,3639:3543,3640:3544,3641:3545,3642:3546,3647:3551,3648:3552,3649:3553,3650:3554,3651:3555,3652:3556,3653:3557,3654:3558,3655:3559,3656:3560,3657:3561,3658:3562,3659:3563,3660:3564,3661:3565,3664:3568,3665:3569,3666:3570,3667:3571,3668:3572,3669:3573,3670:3574,3671:3575,3672:3576,3673:3577,8194:2722,8195:2721,8196:2723,8197:2724,8199:2725,8200:2726,8201:2727,8202:2728,8210:2747,8211:2730,8212:2729,8213:1967,8215:3295,8216:2768,8217:2769,8218:2813,8220:2770,8221:2771,8222:2814,8224:2801,8225:2802,8226:2790,8229:2735,8230:2734,8240:2773,8242:2774,8243:2775,8248:2812,8254:1150,8361:3839,8364:8364,8453:2744,8470:1712,8471:2811,8478:2772,8482:2761,8531:2736,8532:2737,8533:2738,8534:2739,8535:2740,8536:2741,8537:2742,8538:2743,8539:2755,8540:2756,8541:2757,8542:2758,8592:2299,8593:2300,8594:2301,8595:2302,8658:2254,8660:2253,8706:2287,8711:2245,8728:3018,8730:2262,8733:2241,8734:2242,8743:2270,8744:2271,8745:2268,8746:2269,8747:2239,8756:2240,8764:2248,8771:2249,8773:16785992,8800:2237,8801:2255,8804:2236,8805:2238,8834:2266,8835:2267,8866:3068,8867:3036,8868:3010,8869:3022,8968:3027,8970:3012,8981:2810,8992:2212,8993:2213,9109:3020,9115:2219,9117:2220,9118:2221,9120:2222,9121:2215,9123:2216,9124:2217,9126:2218,9128:2223,9132:2224,9143:2209,9146:2543,9147:2544,9148:2546,9149:2547,9225:2530,9226:2533,9227:2537,9228:2531,9229:2532,9251:2732,9252:2536,9472:2211,9474:2214,9484:2210,9488:2539,9492:2541,9496:2538,9500:2548,9508:2549,9516:2551,9524:2550,9532:2542,9618:2529,9642:2791,9643:2785,9644:2779,9645:2786,9646:2783,9647:2767,9650:2792,9651:2787,9654:2781,9655:2765,9660:2793,9661:2788,9664:2780,9665:2764,9670:2528,9675:2766,9679:2782,9702:2784,9734:2789,9742:2809,9747:2762,9756:2794,9758:2795,9792:2808,9794:2807,9827:2796,9829:2798,9830:2797,9837:2806,9839:2805,10003:2803,10007:2804,10013:2777,10016:2800,10216:2748,10217:2750,12289:1188,12290:1185,12300:1186,12301:1187,12443:1246,12444:1247,12449:1191,12450:1201,12451:1192,12452:1202,12453:1193,12454:1203,12455:1194,12456:1204,12457:1195,12458:1205,12459:1206,12461:1207,12463:1208,12465:1209,12467:1210,12469:1211,12471:1212,12473:1213,12475:1214,12477:1215,12479:1216,12481:1217,12483:1199,12484:1218,12486:1219,12488:1220,12490:1221,12491:1222,12492:1223,12493:1224,12494:1225,12495:1226,12498:1227,12501:1228,12504:1229,12507:1230,12510:1231,12511:1232,12512:1233,12513:1234,12514:1235,12515:1196,12516:1236,12517:1197,12518:1237,12519:1198,12520:1238,12521:1239,12522:1240,12523:1241,12524:1242,12525:1243,12527:1244,12530:1190,12531:1245,12539:1189,12540:1200},Dt={lookup:function(e){if(e>=32&&e<=255)return e;let t=Et[e];return t===void 0?16777216|e:t}},F={};(function(){function e(e,t){if(t===void 0)throw Error(`Undefined keysym for key "`+e+`"`);if(e in F)throw Error(`Duplicate entry for key "`+e+`"`);F[e]=[t,t,t,t]}function t(e,t,n){if(t===void 0||n===void 0)throw Error(`Undefined keysym for key "`+e+`"`);if(e in F)throw Error(`Duplicate entry for key "`+e+`"`);F[e]=[t,t,n,t]}function n(e,t,n){if(t===void 0||n===void 0)throw Error(`Undefined keysym for key "`+e+`"`);if(e in F)throw Error(`Duplicate entry for key "`+e+`"`);F[e]=[t,t,t,n]}t(`Alt`,P.XK_Alt_L,P.XK_Alt_R),e(`AltGraph`,P.XK_ISO_Level3_Shift),e(`CapsLock`,P.XK_Caps_Lock),t(`Control`,P.XK_Control_L,P.XK_Control_R),t(`Meta`,P.XK_Super_L,P.XK_Super_R),e(`NumLock`,P.XK_Num_Lock),e(`ScrollLock`,P.XK_Scroll_Lock),t(`Shift`,P.XK_Shift_L,P.XK_Shift_R),n(`Enter`,P.XK_Return,P.XK_KP_Enter),e(`Tab`,P.XK_Tab),n(` `,P.XK_space,P.XK_KP_Space),n(`ArrowDown`,P.XK_Down,P.XK_KP_Down),n(`ArrowLeft`,P.XK_Left,P.XK_KP_Left),n(`ArrowRight`,P.XK_Right,P.XK_KP_Right),n(`ArrowUp`,P.XK_Up,P.XK_KP_Up),n(`End`,P.XK_End,P.XK_KP_End),n(`Home`,P.XK_Home,P.XK_KP_Home),n(`PageDown`,P.XK_Next,P.XK_KP_Next),n(`PageUp`,P.XK_Prior,P.XK_KP_Prior),e(`Backspace`,P.XK_BackSpace),n(`Clear`,P.XK_Clear,P.XK_KP_Begin),e(`Copy`,P.XF86XK_Copy),e(`Cut`,P.XF86XK_Cut),n(`Delete`,P.XK_Delete,P.XK_KP_Delete),n(`Insert`,P.XK_Insert,P.XK_KP_Insert),e(`Paste`,P.XF86XK_Paste),e(`Redo`,P.XK_Redo),e(`Undo`,P.XK_Undo),e(`Cancel`,P.XK_Cancel),e(`ContextMenu`,P.XK_Menu),e(`Escape`,P.XK_Escape),e(`Execute`,P.XK_Execute),e(`Find`,P.XK_Find),e(`Help`,P.XK_Help),e(`Pause`,P.XK_Pause),e(`Select`,P.XK_Select),e(`ZoomIn`,P.XF86XK_ZoomIn),e(`ZoomOut`,P.XF86XK_ZoomOut),e(`BrightnessDown`,P.XF86XK_MonBrightnessDown),e(`BrightnessUp`,P.XF86XK_MonBrightnessUp),e(`Eject`,P.XF86XK_Eject),e(`LogOff`,P.XF86XK_LogOff),e(`Power`,P.XF86XK_PowerOff),e(`PowerOff`,P.XF86XK_PowerDown),e(`PrintScreen`,P.XK_Print),e(`Hibernate`,P.XF86XK_Hibernate),e(`Standby`,P.XF86XK_Standby),e(`WakeUp`,P.XF86XK_WakeUp),e(`AllCandidates`,P.XK_MultipleCandidate),e(`Alphanumeric`,P.XK_Eisu_toggle),e(`CodeInput`,P.XK_Codeinput),e(`Compose`,P.XK_Multi_key),e(`Convert`,P.XK_Henkan),e(`GroupFirst`,P.XK_ISO_First_Group),e(`GroupLast`,P.XK_ISO_Last_Group),e(`GroupNext`,P.XK_ISO_Next_Group),e(`GroupPrevious`,P.XK_ISO_Prev_Group),e(`NonConvert`,P.XK_Muhenkan),e(`PreviousCandidate`,P.XK_PreviousCandidate),e(`SingleCandidate`,P.XK_SingleCandidate),e(`HangulMode`,P.XK_Hangul),e(`HanjaMode`,P.XK_Hangul_Hanja),e(`JunjaMode`,P.XK_Hangul_Jeonja),e(`Eisu`,P.XK_Eisu_toggle),e(`Hankaku`,P.XK_Hankaku),e(`Hiragana`,P.XK_Hiragana),e(`HiraganaKatakana`,P.XK_Hiragana_Katakana),e(`KanaMode`,P.XK_Kana_Shift),e(`KanjiMode`,P.XK_Kanji),e(`Katakana`,P.XK_Katakana),e(`Romaji`,P.XK_Romaji),e(`Zenkaku`,P.XK_Zenkaku),e(`ZenkakuHankaku`,P.XK_Zenkaku_Hankaku),e(`F1`,P.XK_F1),e(`F2`,P.XK_F2),e(`F3`,P.XK_F3),e(`F4`,P.XK_F4),e(`F5`,P.XK_F5),e(`F6`,P.XK_F6),e(`F7`,P.XK_F7),e(`F8`,P.XK_F8),e(`F9`,P.XK_F9),e(`F10`,P.XK_F10),e(`F11`,P.XK_F11),e(`F12`,P.XK_F12),e(`F13`,P.XK_F13),e(`F14`,P.XK_F14),e(`F15`,P.XK_F15),e(`F16`,P.XK_F16),e(`F17`,P.XK_F17),e(`F18`,P.XK_F18),e(`F19`,P.XK_F19),e(`F20`,P.XK_F20),e(`F21`,P.XK_F21),e(`F22`,P.XK_F22),e(`F23`,P.XK_F23),e(`F24`,P.XK_F24),e(`F25`,P.XK_F25),e(`F26`,P.XK_F26),e(`F27`,P.XK_F27),e(`F28`,P.XK_F28),e(`F29`,P.XK_F29),e(`F30`,P.XK_F30),e(`F31`,P.XK_F31),e(`F32`,P.XK_F32),e(`F33`,P.XK_F33),e(`F34`,P.XK_F34),e(`F35`,P.XK_F35),e(`Close`,P.XF86XK_Close),e(`MailForward`,P.XF86XK_MailForward),e(`MailReply`,P.XF86XK_Reply),e(`MailSend`,P.XF86XK_Send),e(`MediaFastForward`,P.XF86XK_AudioForward),e(`MediaPause`,P.XF86XK_AudioPause),e(`MediaPlay`,P.XF86XK_AudioPlay),e(`MediaRecord`,P.XF86XK_AudioRecord),e(`MediaRewind`,P.XF86XK_AudioRewind),e(`MediaStop`,P.XF86XK_AudioStop),e(`MediaTrackNext`,P.XF86XK_AudioNext),e(`MediaTrackPrevious`,P.XF86XK_AudioPrev),e(`New`,P.XF86XK_New),e(`Open`,P.XF86XK_Open),e(`Print`,P.XK_Print),e(`Save`,P.XF86XK_Save),e(`SpellCheck`,P.XF86XK_Spell),e(`AudioVolumeDown`,P.XF86XK_AudioLowerVolume),e(`AudioVolumeUp`,P.XF86XK_AudioRaiseVolume),e(`AudioVolumeMute`,P.XF86XK_AudioMute),e(`MicrophoneVolumeMute`,P.XF86XK_AudioMicMute),e(`LaunchApplication1`,P.XF86XK_MyComputer),e(`LaunchApplication2`,P.XF86XK_Calculator),e(`LaunchCalendar`,P.XF86XK_Calendar),e(`LaunchMail`,P.XF86XK_Mail),e(`LaunchMediaPlayer`,P.XF86XK_AudioMedia),e(`LaunchMusicPlayer`,P.XF86XK_Music),e(`LaunchPhone`,P.XF86XK_Phone),e(`LaunchScreenSaver`,P.XF86XK_ScreenSaver),e(`LaunchSpreadsheet`,P.XF86XK_Excel),e(`LaunchWebBrowser`,P.XF86XK_WWW),e(`LaunchWebCam`,P.XF86XK_WebCam),e(`LaunchWordProcessor`,P.XF86XK_Word),e(`BrowserBack`,P.XF86XK_Back),e(`BrowserFavorites`,P.XF86XK_Favorites),e(`BrowserForward`,P.XF86XK_Forward),e(`BrowserHome`,P.XF86XK_HomePage),e(`BrowserRefresh`,P.XF86XK_Refresh),e(`BrowserSearch`,P.XF86XK_Search),e(`BrowserStop`,P.XF86XK_Stop),e(`Dimmer`,P.XF86XK_BrightnessAdjust),e(`MediaAudioTrack`,P.XF86XK_AudioCycleTrack),e(`RandomToggle`,P.XF86XK_AudioRandomPlay),e(`SplitScreenToggle`,P.XF86XK_SplitScreen),e(`Subtitle`,P.XF86XK_Subtitle),e(`VideoModeNext`,P.XF86XK_Next_VMode),n(`=`,P.XK_equal,P.XK_KP_Equal),n(`+`,P.XK_plus,P.XK_KP_Add),n(`-`,P.XK_minus,P.XK_KP_Subtract),n(`*`,P.XK_asterisk,P.XK_KP_Multiply),n(`/`,P.XK_slash,P.XK_KP_Divide),n(`.`,P.XK_period,P.XK_KP_Decimal),n(`,`,P.XK_comma,P.XK_KP_Separator),n(`0`,P.XK_0,P.XK_KP_0),n(`1`,P.XK_1,P.XK_KP_1),n(`2`,P.XK_2,P.XK_KP_2),n(`3`,P.XK_3,P.XK_KP_3),n(`4`,P.XK_4,P.XK_KP_4),n(`5`,P.XK_5,P.XK_KP_5),n(`6`,P.XK_6,P.XK_KP_6),n(`7`,P.XK_7,P.XK_KP_7),n(`8`,P.XK_8,P.XK_KP_8),n(`9`,P.XK_9,P.XK_KP_9)})();var Ot={8:`Backspace`,9:`Tab`,10:`NumpadClear`,13:`Enter`,16:`ShiftLeft`,17:`ControlLeft`,18:`AltLeft`,19:`Pause`,20:`CapsLock`,21:`Lang1`,25:`Lang2`,27:`Escape`,28:`Convert`,29:`NonConvert`,32:`Space`,33:`PageUp`,34:`PageDown`,35:`End`,36:`Home`,37:`ArrowLeft`,38:`ArrowUp`,39:`ArrowRight`,40:`ArrowDown`,41:`Select`,44:`PrintScreen`,45:`Insert`,46:`Delete`,47:`Help`,48:`Digit0`,49:`Digit1`,50:`Digit2`,51:`Digit3`,52:`Digit4`,53:`Digit5`,54:`Digit6`,55:`Digit7`,56:`Digit8`,57:`Digit9`,91:`MetaLeft`,92:`MetaRight`,93:`ContextMenu`,95:`Sleep`,96:`Numpad0`,97:`Numpad1`,98:`Numpad2`,99:`Numpad3`,100:`Numpad4`,101:`Numpad5`,102:`Numpad6`,103:`Numpad7`,104:`Numpad8`,105:`Numpad9`,106:`NumpadMultiply`,107:`NumpadAdd`,108:`NumpadDecimal`,109:`NumpadSubtract`,110:`NumpadDecimal`,111:`NumpadDivide`,112:`F1`,113:`F2`,114:`F3`,115:`F4`,116:`F5`,117:`F6`,118:`F7`,119:`F8`,120:`F9`,121:`F10`,122:`F11`,123:`F12`,124:`F13`,125:`F14`,126:`F15`,127:`F16`,128:`F17`,129:`F18`,130:`F19`,131:`F20`,132:`F21`,133:`F22`,134:`F23`,135:`F24`,144:`NumLock`,145:`ScrollLock`,166:`BrowserBack`,167:`BrowserForward`,168:`BrowserRefresh`,169:`BrowserStop`,170:`BrowserSearch`,171:`BrowserFavorites`,172:`BrowserHome`,173:`AudioVolumeMute`,174:`AudioVolumeDown`,175:`AudioVolumeUp`,176:`MediaTrackNext`,177:`MediaTrackPrevious`,178:`MediaStop`,179:`MediaPlayPause`,180:`LaunchMail`,181:`MediaSelect`,182:`LaunchApp1`,183:`LaunchApp2`,225:`AltRight`},kt={Backspace:`Backspace`,AltLeft:`Alt`,AltRight:`Alt`,CapsLock:`CapsLock`,ContextMenu:`ContextMenu`,ControlLeft:`Control`,ControlRight:`Control`,Enter:`Enter`,MetaLeft:`Meta`,MetaRight:`Meta`,ShiftLeft:`Shift`,ShiftRight:`Shift`,Tab:`Tab`,Delete:`Delete`,End:`End`,Help:`Help`,Home:`Home`,Insert:`Insert`,PageDown:`PageDown`,PageUp:`PageUp`,ArrowDown:`ArrowDown`,ArrowLeft:`ArrowLeft`,ArrowRight:`ArrowRight`,ArrowUp:`ArrowUp`,NumLock:`NumLock`,NumpadBackspace:`Backspace`,NumpadClear:`Clear`,Escape:`Escape`,F1:`F1`,F2:`F2`,F3:`F3`,F4:`F4`,F5:`F5`,F6:`F6`,F7:`F7`,F8:`F8`,F9:`F9`,F10:`F10`,F11:`F11`,F12:`F12`,F13:`F13`,F14:`F14`,F15:`F15`,F16:`F16`,F17:`F17`,F18:`F18`,F19:`F19`,F20:`F20`,F21:`F21`,F22:`F22`,F23:`F23`,F24:`F24`,F25:`F25`,F26:`F26`,F27:`F27`,F28:`F28`,F29:`F29`,F30:`F30`,F31:`F31`,F32:`F32`,F33:`F33`,F34:`F34`,F35:`F35`,PrintScreen:`PrintScreen`,ScrollLock:`ScrollLock`,Pause:`Pause`,BrowserBack:`BrowserBack`,BrowserFavorites:`BrowserFavorites`,BrowserForward:`BrowserForward`,BrowserHome:`BrowserHome`,BrowserRefresh:`BrowserRefresh`,BrowserSearch:`BrowserSearch`,BrowserStop:`BrowserStop`,Eject:`Eject`,LaunchApp1:`LaunchMyComputer`,LaunchApp2:`LaunchCalendar`,LaunchMail:`LaunchMail`,MediaPlayPause:`MediaPlay`,MediaStop:`MediaStop`,MediaTrackNext:`MediaTrackNext`,MediaTrackPrevious:`MediaTrackPrevious`,Power:`Power`,Sleep:`Sleep`,AudioVolumeDown:`AudioVolumeDown`,AudioVolumeMute:`AudioVolumeMute`,AudioVolumeUp:`AudioVolumeUp`,WakeUp:`WakeUp`},I={isMac:function(){return/Mac|iPod|iPhone|iPad/.test(navigator.platform)},isIOS:function(){return/iPod|iPhone|iPad/.test(navigator.platform)},isWindows:function(){return/Win/.test(navigator.platform)},isLinux:function(){return/Linux/.test(navigator.platform)},isMacDesktop:Ae,hasTextInput:function(){return typeof window.TextEvent==`function`},isChrome:function(){return(navigator.userAgentData&&navigator.userAgentData.brands||[]).some(e=>/Chromium|Google Chrome/.test(e.brand))?!0:!!window.chrome&&(!!window.chrome.webstore||!!window.chrome.runtime)},isSafari:function(){return/Safari/.test(navigator.userAgent)&&!/Chrome/.test(navigator.userAgent)},isFirefox:function(){return/Firefox\//.test(navigator.userAgent)}},At=[`ControlLeft`,`ControlRight`,`MetaLeft`,`MetaRight`];function jt(e){return e===P.XK_Control_L||e===P.XK_Control_R||e===P.XK_Alt_L||e===P.XK_Alt_R||e===P.XK_Super_L||e===P.XK_Super_R||e===P.XK_Meta_L||e===P.XK_Meta_R}var L={[P.XK_Shift_L]:`Shift`,[P.XK_Shift_R]:`Shift`,[P.XK_Control_L]:`Control`,[P.XK_Control_R]:`Control`,[P.XK_Alt_L]:`Alt`,[P.XK_Alt_R]:`Alt`,[P.XK_Meta_L]:`Meta`,[P.XK_Meta_R]:`Meta`,[P.XK_Super_L]:`Meta`,[P.XK_Super_R]:`Meta`,[P.XK_ISO_Level3_Shift]:`Alt`,[P.XK_Mode_switch]:`Alt`},Mt={[P.XK_KP_Space]:P.XK_space,[P.XK_KP_Enter]:P.XK_Return,[P.XK_KP_Equal]:P.XK_equal,[P.XK_KP_Multiply]:P.XK_asterisk,[P.XK_KP_Add]:P.XK_plus,[P.XK_KP_Separator]:P.XK_comma,[P.XK_KP_Subtract]:P.XK_minus,[P.XK_KP_Decimal]:P.XK_period,[P.XK_KP_Divide]:P.XK_slash,[P.XK_KP_0]:P.XK_0,[P.XK_KP_1]:P.XK_1,[P.XK_KP_2]:P.XK_2,[P.XK_KP_3]:P.XK_3,[P.XK_KP_4]:P.XK_4,[P.XK_KP_5]:P.XK_5,[P.XK_KP_6]:P.XK_6,[P.XK_KP_7]:P.XK_7,[P.XK_KP_8]:P.XK_8,[P.XK_KP_9]:P.XK_9},Nt={[P.XK_KP_Home]:P.XK_Home,[P.XK_KP_Up]:P.XK_Up,[P.XK_KP_Page_Up]:P.XK_Page_Up,[P.XK_KP_Prior]:P.XK_Prior,[P.XK_KP_Left]:P.XK_Left,[P.XK_KP_Begin]:P.XK_Clear,[P.XK_KP_Right]:P.XK_Right,[P.XK_KP_End]:P.XK_End,[P.XK_KP_Down]:P.XK_Down,[P.XK_KP_Page_Down]:P.XK_Page_Down,[P.XK_KP_Next]:P.XK_Next,[P.XK_KP_Insert]:P.XK_Insert,[P.XK_KP_Delete]:P.XK_Delete,[P.XK_KP_Enter]:P.XK_Return},R={getKeyCode:function(e){if(e.code){switch(e.code){case`OSLeft`:return`MetaLeft`;case`OSRight`:return`MetaRight`}return e.code}if(e.keyCode in Ot){let t=Ot[e.keyCode];if(I.isMac()&&t===`ContextMenu`&&(t=`MetaRight`),e.location===2)switch(t){case`ShiftLeft`:return`ShiftRight`;case`ControlLeft`:return`ControlRight`;case`AltLeft`:return`AltRight`}if(e.location===3)switch(t){case`Delete`:return`NumpadDecimal`;case`Insert`:return`Numpad0`;case`End`:return`Numpad1`;case`ArrowDown`:return`Numpad2`;case`PageDown`:return`Numpad3`;case`ArrowLeft`:return`Numpad4`;case`ArrowRight`:return`Numpad6`;case`Home`:return`Numpad7`;case`ArrowUp`:return`Numpad8`;case`PageUp`:return`Numpad9`;case`Enter`:return`NumpadEnter`}return t}return`Unidentified`},getKey:function(e){if(e.key!==void 0&&e.key!==`Unidentified`&&e.key!==`Dead`){switch(e.key){case`OS`:return`Meta`;case`LaunchMyComputer`:return`LaunchApplication1`;case`LaunchCalculator`:return`LaunchApplication2`;case`UIKeyInputUpArrow`:return`ArrowUp`;case`UIKeyInputDownArrow`:return`ArrowDown`;case`UIKeyInputLeftArrow`:return`ArrowLeft`;case`UIKeyInputRightArrow`:return`ArrowRight`;case`UIKeyInputEscape`:return`Escape`}return e.key===`\0`&&R.getKeyCode(e)===`NumpadDecimal`?`Delete`:e.key}let t=R.getKeyCode(e);return t in kt?kt[t]:e.charCode?String.fromCharCode(e.charCode):`Unidentified`},getKeysym:function(e){let t=R.getKey(e);if(t===`Unidentified`)return null;if(t in F){let n=e.location;if((I.isSafari()&&t===`Meta`&&n===0||I.isChrome()&&t===`Meta`&&n===0&&R.getKeyCode(e)===`MetaRight`)&&(n=2),t===`Clear`&&n===3&&R.getKeyCode(e)===`NumLock`&&(n=0),(n===void 0||n>3)&&(n=0),t===`Meta`&&(I.isMac()||I.isIOS())){let t=R.getKeyCode(e);if(t===`AltLeft`)return P.XK_Meta_L;if(t===`AltRight`)return P.XK_Meta_R}if(t===`Clear`&&R.getKeyCode(e)===`NumLock`)return P.XK_Num_Lock;if(I.isWindows())switch(t){case`Zenkaku`:case`Hankaku`:return P.XK_Zenkaku_Hankaku;case`Romaji`:case`KanaMode`:return P.XK_Romaji}return F[t][n]}if(t.length!==1)return null;let n=t.charCodeAt();return n?Dt.lookup(n):null},getKeysymFromCode:function(e){if(!e)return null;if(/^Key[A-Z]$/.test(e))return Dt.lookup(e.charCodeAt(3)+32);if(/^Digit[0-9]$/.test(e))return Dt.lookup(e.charCodeAt(5));let t=/^F([1-9]|1[0-2])$/.exec(e);if(t)return P.XK_F1+(parseInt(t[1],10)-1);let n={Minus:45,Equal:61,BracketLeft:91,BracketRight:93,Backslash:92,Semicolon:59,Quote:39,Backquote:96,Comma:44,Period:46,Slash:47,Space:32};if(e in n)return Dt.lookup(n[e]);let r={Tab:P.XK_Tab,Enter:P.XK_Return,Backspace:P.XK_BackSpace,Delete:P.XK_Delete,Escape:P.XK_Escape,Insert:P.XK_Insert,Home:P.XK_Home,End:P.XK_End,PageUp:P.XK_Page_Up,PageDown:P.XK_Page_Down,ArrowUp:P.XK_Up,ArrowDown:P.XK_Down,ArrowLeft:P.XK_Left,ArrowRight:P.XK_Right};return e in r?r[e]:null}},Pt=function(e){e.stopPropagation(),e.preventDefault()},Ft=class e{constructor(t,n,r=!1,i=0,a=!1,o=null){this.element=t,this.send=n,this.sendMotion=null,this.motionBacklog=null,this._pointerSeq=0,this._isSidebarOpen=!1,this.isSharedMode=r,this.controllerSlots=ht(o),this.playerIndex=i,this.cursorDiv=document.createElement(`canvas`),this.cursorDiv.style.position=`fixed`,this.cursorDiv.style.pointerEvents=`none`,this.cursorDiv.style.zIndex=`999999`,this.cursorDiv.style.display=`none`,this.cursorDiv.style.left=`0px`,this.cursorDiv.style.top=`0px`,this.cursorDiv.style.willChange=`transform`,this.cursorImg=this.cursorDiv.getContext(`2d`),document.body.appendChild(this.cursorDiv),this.cursorHotspot={x:0,y:0},this._cursorImageBitmap=null,this._rawHotspotX=0,this._rawHotspotY=0,this.use_browser_cursors=!1,this._latestMouseX=0,this._latestMouseY=0,this.displayId=`primary`,this._echo=null,this._echoDeltas=[],this._echoComposited=!1,this.fingerScroll=!1,this._fingerScrollTimer=null,this._echoTimer=null,this._echoAsking=!1,this.useCssScaling=a,this._streamDensity=null,this.m=null,this._layout=null,this._anchorX=null,this._anchorY=null,this._chromeInsetX=null,this._chromeInsetY=null,this._sampleClientX=-1e9,this._sampleClientY=-1e9,this._sampleAnchorX=NaN,this._sampleAnchorY=NaN,this._geometryTimer=null,this.buttonMask=0,this.gamepadManager=null,this._gamepadAnnounced={},this.gamepadRumble=!0,this.x=0,this.y=0,this._relCarryX=0,this._relCarryY=0,this._pointerScaleFrame=null,this._pendingMove=null,this._moveFlushScheduled=!1,this._lastMotionSend=-1/0,this._rawMotionSeen=!1,this.onmenuhotkey=null,this.gamingMode=!1,this._fullscreenKeyboardLock=!1,this.shortcutsEnabled=!0,this._escapePresses=0,this._lastEscapeAt=0,this.ongamingmode=null,this.onnotice=null,this.onfullscreenhotkey=this.enterFullscreen,this.ongaminghotkey=this.toggleGamingMode,this.ongamepadhotkey=null,this.ongamepadconnected=null,this.ongamepaddisconnected=null,this.listeners=[],this.listeners_context=[],this._queue=new b,this._primaryAsSecondary=!1,this._allowThreshold=!0,this._wheelClassified=!1,this._smallestDeltaY=1e4,this._smallestLineDeltaY=1e4,this._scrollMagnitude=10,this._wheelAccumY=0,this._wheelDirY=null,this._wheelAccumX=0,this._wheelDirX=null,this._pinchCarry=0,this._lastWheelEventTs=0,this.cursorScaleFactor=null,this._cursorBase64Data=null,this._guacKeyboardID=e._nextGuacID++,this._EVENT_MARKER=`_GUAC_KEYBOARD_HANDLED_BY_`+this._guacKeyboardID,this._keyDownList={},this._keyHeartbeatTimer=null,this._KEY_HEARTBEAT_INTERVAL=100,this._altGrArmed=!1,this._altGrTimeout=null,this._altGrCtrlTime=0,this._isSynth=!1,this._altKeysymByCode=new Map,this.isComposing=!1,this.compositionString=``,this._pendingChord=null,this._momentaryChordMods=new Set,this._momentaryChordModsTimer=null,this._chordKeySent=!1,this._lastTextInputCommit=null,this.keyboardInputAssist=document.getElementById(`keyboard-input-assist`),this._assistTyped=``,this._assistComposing=!1,this._activeTouches=new Map,this._activeTouchIdentifier=null,this._isTwoFingerGesture=!1,this._twoFinger=null,this._TAP_THRESHOLD_DISTANCE_SQ=100,this._TAP_MAX_DURATION=250,this._trackpadMode=!1,this._trackpadTouches=new Map,this._trackpadGestureMode=null,this._trackpadReleaseTimer=null,this._trackpadHandoffAt=-1/0,this.trackpadSpeed=1,this.inputAttached=!1}setSharedMode(e){this.isSharedMode=!!e}updateControllerSlot(e){let t=ht(e);String(t)!==String(this.controllerSlots)&&(console.log(`Input class: Controller slots updated to: ${t}`),this.controllerSlots=t,this.gamepadManager&&(this.gamepadManager.setSlotCount(t?t.length:1),this.gamepadManager.reannounce()))}_handleVisibilityMessage(e){if(e.origin!==window.location.origin)return;let t=e.data;typeof t==`object`&&t&&t.type===`sidebarVisibilityChanged`&&(this._isSidebarOpen=!!t.isOpen)}static _asksRawMotion(){return e.rawPointerMotion&&!e._rawMotionRefused}static _viewportSettled(){let e=window.mozInnerScreenX,t=window.mozInnerScreenY;return typeof e!=`number`||typeof t!=`number`||Math.abs(e-window.screenX)<1&&Math.abs(t-window.screenY)<1}_drawAndScaleCursor(){if(!this._cursorImageBitmap)return;let e=this._cursorDensity(),t=this._cursorImageBitmap;this.cursorDiv.width=t.width,this.cursorDiv.height=t.height,this.cursorDiv.style.width=`${t.width/e}px`,this.cursorDiv.style.height=`${t.height/e}px`,this.cursorImg.clearRect(0,0,t.width,t.height),this.cursorImg.drawImage(t,0,0),this.cursorHotspot.x=this._rawHotspotX/e,this.cursorHotspot.y=this._rawHotspotY/e,this._trackpadMode?this._placeEchoCursor():this._updateCursorPosition(this._latestMouseX,this._latestMouseY)}_handleOutsideClick(e){!this.use_browser_cursors&&!this._trackpadMode&&!this.element.contains(e.target)&&(this.cursorDiv.style.display=`none`)}_updateCursorPosition(e,t){if(this.cursorDiv.style.display!==`none`){let n=e-this.cursorHotspot.x,r=t-this.cursorHotspot.y;this.cursorDiv.style.transform=`translate(${n}px, ${r}px)`}}_cursorImageSetFunction(){if(e._cursorImageSetFn===void 0&&(e._cursorImageSetFn=null,typeof CSS<`u`&&CSS.supports)){for(let t of[`image-set`,`-webkit-image-set`])if(CSS.supports(`cursor`,`${t}(url("data:image/png;base64,") 2x) 0 0, default`)){e._cursorImageSetFn=t;break}}return e._cursorImageSetFn}_updateBrowserCursor(){if(!this._cursorBase64Data){this.element.style.setProperty(`cursor`,`none`,`important`);return}let e=`url("data:image/png;base64,${this._cursorBase64Data}")`,t=this._cursorDensity(),n=`${e} ${this._rawHotspotX} ${this._rawHotspotY}, default`,r=t===1?null:this._cursorImageSetFunction();r&&(n=`${r}(${e} ${t}x) ${Math.round(this._rawHotspotX/t)} ${Math.round(this._rawHotspotY/t)}, default`),this.element.style.setProperty(`cursor`,n,`important`)}_cursorBitmapFromBase64(e){let t=Uint8Array.from(atob(e),e=>e.charCodeAt(0));return createImageBitmap(new Blob([t],{type:`image/png`}))}async updateServerCursor(e){if(!e.curdata||parseInt(e.handle,10)===0){this._cursorImageBitmap=null,this._cursorBase64Data=null,this.cursorDiv.style.display=`none`,this.use_browser_cursors&&this.element.style.setProperty(`cursor`,`none`,`important`);return}if(this._rawHotspotX=parseInt(e.hotx)||0,this._rawHotspotY=parseInt(e.hoty)||0,this._cursorBase64Data=e.curdata,this._cursorImageBitmap=null,!this.inputAttached){this.cursorDiv.style.display=`none`,this.element.style.cursor=`auto`;return}this._trackpadMode?(this._cursorImageBitmap=await this._cursorBitmapFromBase64(this._cursorBase64Data),this._drawAndScaleCursor()):this.use_browser_cursors?(this.cursorDiv.style.display=`none`,this._updateBrowserCursor()):(this._cursorImageBitmap=await this._cursorBitmapFromBase64(this._cursorBase64Data),this.element.style.setProperty(`cursor`,`none`,`important`),this.cursorDiv.style.display=`block`,this._drawAndScaleCursor())}setSynth(e){console.log(`Input: Synthetic mode ${e?`enabled`:`disabled`}.`),this._isSynth=e}updateCssScaling(e){this.useCssScaling!==e&&(console.log(`Input: Updating useCssScaling from ${this.useCssScaling} to ${e}`),this.useCssScaling=e,this._windowMath(),this._refreshCursorScale())}_sendKeyEvent(e,t,n){if(e===null)return;let r=e;if(Object.prototype.hasOwnProperty.call(Mt,e)?r=Mt[e]:Object.prototype.hasOwnProperty.call(Nt,e)&&(r=Nt[e]),n)this._keyDownList[t]=r;else{if(!(t in this._keyDownList))return;r=this._keyDownList[t],delete this._keyDownList[t]}this.send((n?`kd,`:`ku,`)+r),n?(this._noteChordKey(r),this._startKeyHeartbeat()):Object.keys(this._keyDownList).length===0&&this._stopKeyHeartbeat()}_startKeyHeartbeat(){this._keyHeartbeatTimer===null&&(this._keyHeartbeatTimer=setInterval(()=>{let e=Object.values(this._keyDownList);if(e.length===0){this._stopKeyHeartbeat();return}this.send(`kh,`+e.join(`,`))},this._KEY_HEARTBEAT_INTERVAL))}_stopKeyHeartbeat(){this._keyHeartbeatTimer!==null&&(clearInterval(this._keyHeartbeatTimer),this._keyHeartbeatTimer=null)}_sendMomentaryKey(e){e!==null&&(this._noteChordKey(e),this.send(`kd,`+e),this.send(`ku,`+e))}_noteChordKey(e){!jt(e)&&this._chordModifierHeld()&&(this._chordKeySent=!0)}_focusCompositionHost(){let e=this.element;if(!e||typeof e.focus!=`function`)return;let t=document.activeElement;if(!t||t===document.body||t===e||t.tagName!==`INPUT`&&t.tagName!==`TEXTAREA`&&!t.isContentEditable)try{e.focus({preventScroll:!0})}catch{}}_releaseDesyncedModifiers(e){if(!(typeof e.getModifierState!=`function`||this._isSynth)&&!(this.isComposing||e.isComposing||e.keyCode===229||e.key===`Process`)){St(e)||this._altKeysymByCode.clear();for(let t in this._keyDownList){let n=this._keyDownList[t],r=xt[t],i=L[n];(r||i)&&(Ct(e,r)||Ct(e,i)||this._releaseLostKey(t))}}}_releaseLostKey(e){this._sendKeyEvent(this._keyDownList[e],e,!1),I.isMac()&&xt[e]===`Meta`&&this._releaseUnderCommand()}_releaseUnderCommand(){for(let e of Object.keys(this._keyDownList))xt[e]||(console.log(`macOS: Force-releasing stuck key: ${e}`),this._sendKeyEvent(this._keyDownList[e],e,!1))}resetKeyboard(){this._stopKeyHeartbeat(),clearTimeout(this._altGrTimeout),this._altGrArmed=!1;for(let e in this._keyDownList)this._sendKeyEvent(this._keyDownList[e],e,!1);this._keyDownList={},this._altKeysymByCode.clear()}_onVisibilityChange(){document.visibilityState===`hidden`&&this.resetKeyboard()}_guac_markEvent(e){return!e[this._EVENT_MARKER]&&(e[this._EVENT_MARKER]=!0,!0)}_handleKeyDown(t){if(this._escapeHatch(t)){Pt(t);return}if(t.ctrlKey&&t.shiftKey&&this.shortcutsEnabled){let e=null;if(t.code===`KeyM`&&!this.gamingMode?e=this.onmenuhotkey:t.code===`KeyF`&&document.fullscreenElement===null?e=this.onfullscreenhotkey:t.code===`KeyX`?e=this.ongaminghotkey:t.code===`KeyG`&&(e=this.ongamepadhotkey),e!==null&&this._guac_markEvent(t)){e.call(this),Pt(t);return}}if(this._targetHasClass(t.target,j)||!this._guac_markEvent(t))return;this._chordKeySent=!1,this._releaseDesyncedModifiers(t);let n=R.getKeyCode(t);if(n===`CapsLock`&&R.getKey(t)===`CapsLock`){Pt(t);return}if(n in this._keyDownList){if(t.repeat){Pt(t);return}this._releaseLostKey(n)}if(this.isComposing||t.isComposing||t.keyCode===229){let e=this._altGrArmed;if((t.ctrlKey||t.altKey||t.metaKey||e)&&t.key!==`Dead`&&!this._composesText(t)){let n=R.getKeysymFromCode(t.code);if(n){if(this.isComposing||t.isComposing)this._pendingChord={keysym:n,ctrl:t.ctrlKey||e,alt:t.altKey,meta:t.metaKey,shift:t.shiftKey,at:performance.now()};else{this._altGrArmed&&(this._altGrArmed=!1,clearTimeout(this._altGrTimeout));let r=this._missingChordModifiers({ctrl:t.ctrlKey||e,alt:t.altKey,meta:t.metaKey,shift:t.shiftKey});this._noteMomentaryChordMods(r);for(let e of r)this.send(`kd,`+e);this._sendMomentaryKey(n);for(let e of r.reverse())this.send(`ku,`+e)}}}Pt(t);return}let r=R.getKeyCode(t),i=R.getKeysym(t);if(this._altGrArmed&&(this._altGrArmed=!1,clearTimeout(this._altGrTimeout),r===`AltRight`&&t.timeStamp-this._altGrCtrlTime<50?i=P.XK_ISO_Level3_Shift:this._sendKeyEvent(P.XK_Control_L,`ControlLeft`,!0)),i!==null&&!this._composesText(t)&&(t.ctrlKey||t.metaKey||t.altKey)){let e=R.getKey(t);if(typeof e==`string`&&[...e].length===1&&e.codePointAt(0)>127){let e=R.getKeysymFromCode(t.code);e&&(i=e)}}if(r===`Unidentified`&&i){this._sendMomentaryKey(i),Pt(t);return}if(I.isMac()&&e.macCmdAsCtrl&&Tt(t)&&r!==`MetaLeft`&&r!==`MetaRight`&&t.metaKey&&!t.ctrlKey&&!t.altKey&&!this._commandIsControl()){if(this._keyDownList.MetaLeft||this._keyDownList.MetaRight){console.log(`macOS: Cmd+key detected for code '${r}'. Remapping Cmd to Ctrl.`);let e=this._keyDownList.MetaLeft?`MetaLeft`:`MetaRight`;this._keyDownList.MetaLeft&&this._sendKeyEvent(this._keyDownList.MetaLeft,`MetaLeft`,!1),this._keyDownList.MetaRight&&this._sendKeyEvent(this._keyDownList.MetaRight,`MetaRight`,!1),this._sendKeyEvent(P.XK_Control_L,e,!0)}else this._sendKeyEvent(P.XK_Control_L,`MetaLeft`,!0)}if((I.isMac()||I.isIOS())&&Tt(t))switch(i){case P.XK_Super_L:e.macCmdAsCtrl&&(i=P.XK_Alt_L);break;case P.XK_Super_R:i=P.XK_Super_L;break;case P.XK_Alt_L:i=P.XK_Mode_switch;break;case P.XK_Alt_R:i=P.XK_ISO_Level3_Shift}if(xt[r]===`Alt`&&this._altKeysymByCode.set(r,i),(I.isMac()||I.isIOS())&&Tt(t)&&i===P.XK_ISO_Level3_Shift){console.log(`macOS: AltRight pressed, sending ISO_Level3_Shift momentarily`),this._sendMomentaryKey(P.XK_ISO_Level3_Shift),Pt(t);return}r in this._keyDownList&&(i=this._keyDownList[r]);let a=[P.XK_Zenkaku_Hankaku,P.XK_Eisu_toggle,P.XK_Katakana,P.XK_Hiragana,P.XK_Romaji];if(I.isWindows()&&a.includes(i)){this._sendMomentaryKey(i),Pt(t);return}if((I.isChrome()||r!==`KeyV`||!t.ctrlKey&&!t.metaKey||t.altKey||this.isComposing)&&Pt(t),r===`ControlLeft`&&I.isWindows()&&Tt(t)&&!(r in this._keyDownList)){this._altGrArmed=!0,this._altGrCtrlTime=t.timeStamp,this._altGrTimeout=setTimeout(()=>{this._altGrArmed=!1,this._sendKeyEvent(P.XK_Control_L,`ControlLeft`,!0)},100);return}let o=I.isMac()&&t.metaKey&&Tt(t)&&i!==null&&!xt[r];if(i!==null&&!xt[r]&&(t.ctrlKey||t.altKey||t.metaKey)&&!this._composesText(t)){let e=this._missingChordModifiers({ctrl:t.ctrlKey,alt:t.altKey,meta:t.metaKey&&!this._commandIsControl(),shift:t.shiftKey});if(e.length>0){this._noteMomentaryChordMods(e);for(let t of e)this.send(`kd,`+t);this._sendKeyEvent(i,r,!0),o&&this._sendKeyEvent(i,r,!1);for(let t of e.reverse())this.send(`ku,`+t);return}}this._sendKeyEvent(i,r,!0),o&&this._sendKeyEvent(i,r,!1)}_escapeHatch(e){if(!this.gamingMode||e.repeat)return!1;let t=performance.now();return(e.code!==`Escape`||t-this._lastEscapeAt>1e3)&&(this._escapePresses=0),this._lastEscapeAt=t,e.code!==`Escape`||(this._escapePresses+=1,this._escapePresses<3)?!1:(this._escapePresses=0,this.toggleGamingMode(),!0)}_handleKeyUp(e){if(this._targetHasClass(e.target,j)){let t=R.getKeyCode(e);t in this._keyDownList&&this._releaseLostKey(t);return}if(!this._guac_markEvent(e))return;Pt(e);let t=R.getKeyCode(e);if(t===`CapsLock`&&R.getKey(e)===`CapsLock`)return;I.isMac()&&(t===`MetaLeft`||t===`MetaRight`)&&(console.log(`macOS: Command key ('${t}') released. Cleaning up potentially stuck keys.`),this._releaseUnderCommand()),this._altGrArmed&&(this._altGrArmed=!1,clearTimeout(this._altGrTimeout),this._sendKeyEvent(P.XK_Control_L,`ControlLeft`,!0)),this._altKeysymByCode.delete(t);let n=this._keyDownList[t];this._sendKeyEvent(n,t,!1),I.isWindows()&&(t===`ShiftLeft`||t===`ShiftRight`)&&(`ShiftRight`in this._keyDownList&&this._sendKeyEvent(this._keyDownList.ShiftRight,`ShiftRight`,!1),`ShiftLeft`in this._keyDownList&&this._sendKeyEvent(this._keyDownList.ShiftLeft,`ShiftLeft`,!1))}_updateCompositionText(e){this.compositionString=this._streamTextDiff(this.compositionString,e||``,!0)}_streamTextDiff(e,t,n=!1){let r=Array.from(e),i=Array.from(t),a=0;for(;a<r.length&&a<i.length&&r[a]===i[a];)a++;let o=r.length-a;for(let e=0;e<o;e++)this._sendMomentaryKey(P.XK_BackSpace);let s=[];for(let e=a;e<i.length;e++){let t=Dt.lookup(i[e].codePointAt(0));t&&s.push([i[e],t])}if(!n||!this._sendAsCommit(s))for(let[,e]of s)this._sendMomentaryKey(e);return t}_sendAsCommit(e){return e.length<2||!e.some(([,e])=>e>=16777216)||this._chordModifierHeld()?!1:(this.send(`co,end,`+e.map(([e])=>e).join(``)),!0)}_compositionStart(e){this._guac_markEvent(e)&&(this.isComposing=!0,this.compositionString=``,this._lastTextInputCommit=null,this._pendingChord=null)}_flushPendingChord(){let e=this._pendingChord;if(this._pendingChord=null,e===null||performance.now()-e.at>500)return;let t=[];e.ctrl&&t.push(P.XK_Control_L),e.alt&&t.push(P.XK_Alt_L),e.meta&&t.push(P.XK_Super_L),e.shift&&t.push(P.XK_Shift_L),this._noteMomentaryChordMods(t);for(let e of t)this.send(`kd,`+e);this.send(`kd,`+e.keysym),this.send(`ku,`+e.keysym);for(let e of t.reverse())this.send(`ku,`+e)}_compositionUpdate(e){this._guac_markEvent(e)&&this.isComposing&&this._updateCompositionText(e.data)}_compositionEnd(e){if(!this._guac_markEvent(e)||!this.isComposing)return;this._pendingChord!==null&&setTimeout(()=>this._flushPendingChord(),0);let t=this._lastTextInputCommit,n=t!==null&&t.data===e.data&&performance.now()-t.at<400;if(I.isLinux()&&I.hasTextInput()||!e.data||n){this._updateCompositionText(``),this.isComposing=!1,this.compositionString=``,this._clearCompositionHostSoon();return}this._updateCompositionText(e.data),this.isComposing=!1,this.compositionString=``,this._clearCompositionHostSoon()}_clearCompositionHostSoon(){setTimeout(()=>{if(this.isComposing)return;let e=this.element;e&&e.tagName===`INPUT`&&e.value&&(e.value=``),this._resetAssist()},0)}_resetAssist(){let e=this.keyboardInputAssist;e&&e.value&&(e.value=``),this._assistTyped=``}_assistCompositionStart(e){this._guac_markEvent(e)&&(this.isComposing=!0,this._assistComposing=!0,this._lastTextInputCommit=null,this._pendingChord=null)}_assistCompositionEnd(e){this._guac_markEvent(e)&&this._assistComposing&&(this._pendingChord!==null&&setTimeout(()=>this._flushPendingChord(),0),this.isComposing=!1,this._assistComposing=!1,this._assistTyped=this._streamTextDiff(this._assistTyped,e.target.value||``),this._clearCompositionHostSoon())}_assistFocusChange(){this._assistComposing&&(this._assistComposing=!1,this.isComposing=!1),this._assistTyped=``}_typeText(e){let t=[];for(let n of e){let e=Dt.lookup(n.codePointAt(0));e&&t.push([n,e])}if(!this._sendAsCommit(t))for(let[,e]of t)this.send(`kd,`+e),this.send(`ku,`+e)}_handleTextInput(e){e.data&&(this._chordEchoPending()||(this.isComposing&&this.compositionString===e.data?this.compositionString=``:(this.isComposing&&this._updateCompositionText(``),this._typeText(e.data)),this._lastTextInputCommit={data:e.data,at:performance.now()},this._clearCompositionHostSoon()))}_chordModifierHeld(){if(this._momentaryChordMods.size>0)return!0;for(let e in this._keyDownList)if(jt(this._keyDownList[e]))return!0;return!1}_chordEchoPending(){return!this._chordModifierHeld()||!this._chordKeySent?!1:(this._chordKeySent=!1,!0)}_missingChordModifiers({ctrl:e,alt:t,meta:n,shift:r}){let i=[];return e&&!this._keysymHeld(P.XK_Control_L,P.XK_Control_R)&&i.push(P.XK_Control_L),t&&!this._keysymHeld(P.XK_Alt_L,P.XK_Alt_R)&&i.push(P.XK_Alt_L),n&&!this._keysymHeld(P.XK_Super_L,P.XK_Super_R,P.XK_Meta_L,P.XK_Meta_R)&&i.push(P.XK_Super_L),r&&!this._keysymHeld(P.XK_Shift_L,P.XK_Shift_R)&&i.push(P.XK_Shift_L),i}_noteMomentaryChordMods(e){for(let t of e)this._momentaryChordMods.add(t);clearTimeout(this._momentaryChordModsTimer),this._momentaryChordModsTimer=setTimeout(()=>this._momentaryChordMods.clear(),250)}_composesText(e){if(!wt(R.getKey(e)))return!1;for(let e of At)if(e in this._keyDownList)return!1;return(e.ctrlKey||e.metaKey)&&!(typeof e.getModifierState==`function`&&e.getModifierState(`AltGraph`))?!1:St(e)&&this._altShiftsLevel(e)}_altShiftsLevel(e){if(this._altKeysymByCode.size===0)return typeof e.getModifierState==`function`&&e.getModifierState(`AltGraph`);for(let e of this._altKeysymByCode.values())if(e===P.XK_Alt_L||e===P.XK_Alt_R)return!1;return!0}_keysymHeld(...e){for(let t in this._keyDownList)if(e.includes(this._keyDownList[t]))return!0;return!1}_commandIsControl(){return this._keyDownList.MetaLeft===P.XK_Control_L||this._keyDownList.MetaRight===P.XK_Control_L}_handleMobileInput(e){let t=e.target;if(this._chordEchoPending()){this._resetAssist();return}let n=t.value||``;(!this.isComposing||n)&&(this._assistTyped=this._streamTextDiff(this._assistTyped,n),this.isComposing||this._resetAssist())}_pressedButton(e,t){return e.button===2?(t&&(this._primaryAsSecondary=e.ctrlKey&&(e.buttons&3)==1),this._primaryAsSecondary?(t||(this._primaryAsSecondary=!1),0):2):e.button}_mouseButtonMovement(e){let t=e.type===`pointerrawupdate`,n=!t&&this._rawMotionSeen&&(e.type===`mousemove`||e.type===`pointermove`);if(e.type===`mousemove`&&(this._rawMotionSeen=!1),this.buttonMask===0&&e.target!==this.element)return;if(this._noteScreenAnchor(e),!t){this.inputAttached&&!this.use_browser_cursors&&!this._trackpadMode&&(this.cursorDiv.style.display=`block`,this.element.style.setProperty(`cursor`,`none`,`important`));let t=e.clientX,n=e.clientY;if(e.getPredictedEvents&&typeof e.getPredictedEvents==`function`){let r=e.getPredictedEvents();if(r.length>0){let e=r[r.length-1];t=e.clientX,n=e.clientY}}this.inputAttached&&!this.use_browser_cursors&&!this._trackpadMode&&this._updateCursorPosition(t,n),this._latestMouseX=t,this._latestMouseY=n}if(this._trackpadMode||n)return;let r=this._inputDpr(),i=+(e.type===`mousedown`||e.type===`pointerdown`);i&&this._releaseDesyncedModifiers(e),i&&e.target===this.element&&document.activeElement!==this.element&&this._focusCompositionHost();var a=`m`;let o=0,s=0,c=document.getElementById(`videoCanvas`),l=document.getElementById(`stream`);if((e.type===`mousedown`||e.type===`mouseup`||e.type===`pointerdown`||e.type===`pointerup`||e.type===`pointercancel`)&&(e.button===1&&e.preventDefault(),(e.button===3||e.button===4)&&e.preventDefault()),i&&e.button===0&&e.ctrlKey&&e.shiftKey&&this.shortcutsEnabled){let t=this._streamLockTargets().includes(e.target)?e.target:this.element,n=()=>this._requestPointerLock(t,n,e=>console.error(`Pointer lock failed:`,e));n(),e.preventDefault();return}if(i&&e.button===0&&this.gamingMode&&this._armPointerLock(),this._isStreamLocked())a=`m2`,o=e.movementX||0,s=e.movementY||0;else if((e.type===`mousemove`||e.type===`pointermove`||t||e.type===`mousedown`||e.type===`mouseup`||e.type===`pointerdown`||e.type===`pointerup`)&&!this._applySinkCoordinates(e.clientX,e.clientY,c,l,e.screenX,e.screenY)){if(this.m||this._windowMath(),this.m){let t=this._clientToServerX(e.clientX)*r,n=this._clientToServerY(e.clientY)*r;this._mapToLayout(t,n,this.m.mouseMultiX*r,this.m.mouseMultiY*r,e.screenX,e.screenY)||(this.x=Math.round(t),this.y=Math.round(n))}else this.x=0,this.y=0}if(e.type===`mousedown`||e.type===`mouseup`||(e.type===`pointerdown`||e.type===`pointerup`)&&e.button>=0){var u=1<<this._pressedButton(e,i);i?this.buttonMask|=u:this.buttonMask&=~u}else e.target===this.element&&(this.buttonMask=bt(e.buttons));let d=a===`m2`?o:this.x,f=a===`m2`?s:this.y;if(e.type===`mousemove`||e.type===`pointermove`||t)this._queueCoalescedMouseMove(a,d,f,this.buttonMask);else if(this._flushCoalescedMouseMove(),a===`m2`){let e=this._relativeToServer(d,f);this._sendPointer([`m2`,e[0],e[1],this.buttonMask,0],!1)}else this._sendPointer([`m`,d,f,this.buttonMask,0],!1)}_queueCoalescedMouseMove(e,t,n,r){if(e===`m2`?this._pendingMove&&this._pendingMove.mtype===`m2`?(this._pendingMove.x+=t,this._pendingMove.y+=n,this._pendingMove.buttonMask=r):(this._flushCoalescedMouseMove(),this._pendingMove={mtype:`m2`,x:t,y:n,buttonMask:r}):(this._pendingMove&&this._pendingMove.mtype!==`m`&&this._flushCoalescedMouseMove(),this._pendingMove={mtype:`m`,x:t,y:n,buttonMask:r}),this._moveFlushScheduled)return;let i=tt-(performance.now()-(this._lastMotionSend||0)),a=typeof this.motionBacklog==`function`&&this.motionBacklog()>nt;if(i<=0&&!a){this._flushCoalescedMouseMove();return}this._moveFlushScheduled=!0;let o=()=>{this._moveFlushScheduled=!1,this._flushCoalescedMouseMove()};a&&window.requestAnimationFrame?window.requestAnimationFrame(o):setTimeout(o,Math.max(0,i))}_flushCoalescedMouseMove(){let e=this._pendingMove;if(e){if(this._pendingMove=null,e.mtype===`m2`){let t=this._relativeToServer(e.x,e.y);if(t[0]===0&&t[1]===0)return;this._sendPointer([e.mtype,t[0],t[1],e.buttonMask,0],!0)}else this._sendPointer([e.mtype,e.x,e.y,e.buttonMask,0],!0);this._lastMotionSend=performance.now()}}_handleRawPointerUpdate(e){if(e.pointerType===`touch`){this._trackpadRawUpdate(e);return}(e.pointerType===`mouse`||e.pointerType===`pen`)&&(this._rawMotionSeen=!0,this._sendCoalescedContact(e),this._mouseButtonMovement(e))}_sendCoalescedContact(e){if(e.buttons===0||typeof e.getCoalescedEvents!=`function`||this._isStreamLocked())return;let t=e.getCoalescedEvents(),n=this._moveFlushScheduled,r=this._lastMotionSend;this._moveFlushScheduled=!0;let i=-1/0;for(let e=0;e+1<t.length;e++)t[e].timeStamp-i<tt||(i=t[e].timeStamp,this._mouseButtonMovement(t[e]),this._flushCoalescedMouseMove());this._moveFlushScheduled=n,this._lastMotionSend=r}_sendPointer(e,t){this._pointerSeq+=1;let n=e.join(`,`)+`,`+this._pointerSeq;if((t&&this.sendMotion||this.send)(n),this._trackpadMode&&!this._echoComposited&&e[0]===`m2`&&(e[1]!==0||e[2]!==0)){if(this._echoDeltas.push([this._pointerSeq,e[1],e[2]]),this._echoDeltas.length>pt){let[,e,t]=this._echoDeltas.shift();this._echo&&([this._echo.x,this._echo.y]=this._echoStep(this._echo.x,this._echo.y,e,t))}this._placeEchoCursor()}}_handlePointerDown(e){e.pointerType===`pen`&&(e.preventDefault(),this._mouseButtonMovement(e))}_handlePointerMove(e){e.pointerType===`pen`&&(this._rawMotionSeen||this._sendCoalescedContact(e),this._mouseButtonMovement(e))}_handlePointerUp(e){e.pointerType===`pen`&&this._mouseButtonMovement(e)}_handleTrackpadEvent(e){if(this._targetHasClass(e.target,j))return;e.preventDefault(),e.stopPropagation();let t=e.type,n=e.changedTouches;if(t===`touchstart`){for(let t of n)this._trackpadTouches.set(t.identifier,{id:t.identifier,startX:t.clientX,startY:t.clientY,lastX:t.clientX,lastY:t.clientY,lastT:e.timeStamp,speed:null,moved:!1});let t=this._trackpadTouches.size;if(t===1)this._trackpadReleaseTimer===null?this._trackpadGestureMode=`moving`:(clearTimeout(this._trackpadReleaseTimer),this._trackpadReleaseTimer=null,this._trackpadGestureMode=`dragging`);else if(t===2){this._trackpadReleaseButton(),this._trackpadGestureMode=`scrolling`;let[e,t]=this._trackpadTouches.values();this._twoFingerStart(e.lastX,e.lastY,t.lastX,t.lastY)}else this._trackpadReleaseButton(),this._trackpadGestureMode=t===3?`three`:`completed`,this._twoFinger=null}else if(t===`touchmove`){for(let e of this._trackpadTouches.values())if(!e.moved){let t=Array.from(n).find(t=>t.identifier===e.id)||e,r=t.clientX-e.startX,i=t.clientY-e.startY;r*r+i*i>this._TAP_THRESHOLD_DISTANCE_SQ&&(e.moved=!0)}if(this._trackpadGestureMode===`moving`||this._trackpadGestureMode===`dragging`){let t=this._trackpadTouches.values().next().value,r=t&&Array.from(n).find(e=>e.identifier===t.id);r&&this._trackpadMove(t,r.clientX,r.clientY,e.timeStamp)}else{for(let e of n){let t=this._trackpadTouches.get(e.identifier);t&&(t.lastX=e.clientX,t.lastY=e.clientY)}if(this._trackpadGestureMode===`scrolling`&&this._trackpadTouches.size===2){let[e,t]=this._trackpadTouches.values();this._twoFingerMove(e.lastX,e.lastY,t.lastX,t.lastY)}}}else if(t===`touchend`||t===`touchcancel`){let e=this._trackpadTouches.size,r=t===`touchend`&&!Array.from(this._trackpadTouches.values()).some(e=>e.moved),i=this._trackpadGestureMode;if((e===2||e===3)&&r&&i!==`completed`){let t=e===2?4:2;this.buttonMask|=t,this._sendPointer([`m2`,0,0,this.buttonMask,0],!1),setTimeout(()=>{this.buttonMask&=~t,this._sendPointer([`m2`,0,0,this.buttonMask,0],!1)},50),this._trackpadGestureMode=`completed`}else e===1&&i===`moving`&&r?(this.buttonMask|=1,this._sendPointer([`m2`,0,0,this.buttonMask,0],!1),this._trackpadReleaseTimer=setTimeout(()=>{this._trackpadReleaseTimer=null,this._trackpadReleaseButton()},it)):e===1&&i===`dragging`&&(this._trackpadReleaseButton(),r&&(this.buttonMask|=1,this._sendPointer([`m2`,0,0,this.buttonMask,0],!1),this._trackpadReleaseButton()));for(let e of n)this._trackpadTouches.delete(e.identifier);if(this._trackpadTouches.size===0)this._trackpadGestureMode=null,this._twoFinger=null;else if(this._trackpadTouches.size===1&&e>1){let[e]=this._trackpadTouches.values();e.moved=!0,this._trackpadGestureMode=`moving`,this._trackpadHandoffAt=performance.now(),this._twoFinger=null}}}_trackpadRawUpdate(e){let t=this._trackpadGestureMode;!this._trackpadMode||this._trackpadTouches.size!==1||t!==`moving`&&t!==`dragging`||this._trackpadMove(this._trackpadTouches.values().next().value,e.clientX,e.clientY,e.timeStamp)}_trackpadMove(e,t,n,r){let i=t-e.lastX,a=n-e.lastY,o=r-e.lastT;if(o>0&&(i!==0||a!==0)){let t=Math.hypot(i,a)/o;e.speed=e.speed===null?t:e.speed+(1-Math.exp(-o/M))*(t-e.speed),e.lastT=r}if(performance.now()-this._trackpadHandoffAt>=at){let t=mt(e.speed||0)*this.trackpadSpeed,n=this._relativeToServer(i*t,a*t);(n[0]!==0||n[1]!==0)&&this._sendPointer([`m2`,n[0],n[1],this.buttonMask,0],!0)}e.lastX=t,e.lastY=n}setTrackpadSpeed(e){let t=Number(e);Number.isFinite(t)&&(this.trackpadSpeed=Math.min(ct,Math.max(st,t)))}_trackpadReleaseButton(){this._trackpadReleaseTimer!==null&&(clearTimeout(this._trackpadReleaseTimer),this._trackpadReleaseTimer=null),this.buttonMask&1&&(this.buttonMask&=-2,this._sendPointer([`m2`,0,0,this.buttonMask,0],!1))}_sinkBox(e,t,n=!1){let r=(n||window.manual_resolution||this.isSharedMode||window.streamResolutionDiverged)&&e?e:(n||window.manualResolution||window.streamResolutionDiverged)&&t?t:null;if(!r||n&&r.tagName===`VIDEO`&&!(r.videoWidth>0&&r.videoHeight>0))return null;let i=r.getBoundingClientRect();if(!(i.width>0&&i.height>0)){this._sinkMirrors||={};for(let e of[`videoStream`,`videoWorkerCanvas`]){let t=this._sinkMirrors[e];if((!t||!t.isConnected)&&(t=document.getElementById(e),this._sinkMirrors[e]=t),!t)continue;let n=t.getBoundingClientRect();if(n.width>0&&n.height>0){i=n;break}}}!(i.width>0&&i.height>0)&&this._lastSinkRect&&(i=this._lastSinkRect);let a=r.videoWidth||r.width,o=r.videoHeight||r.height;if(i.width>0&&i.height>0&&a>0&&o>0){this._lastSinkRect=i;let e=i.left,t=i.top,n=i.width,s=i.height;if(r.tagName===`VIDEO`&&(r.style.objectFit||`contain`)!==`fill`){let r=Math.min(i.width/a,i.height/o);n=a*r,s=o*r,e+=(i.width-n)/2,t+=(i.height-s)/2}return{boxLeft:e,boxTop:t,boxW:n,boxH:s,sinkW:a,sinkH:o}}return null}_noteScreenAnchor(e){let t=e.screenX,n=e.screenY;if(!Number.isFinite(t)||!Number.isFinite(n)||Math.abs(e.clientX-this._sampleClientX)+Math.abs(e.clientY-this._sampleClientY)<8)return;let r=t-e.clientX,i=n-e.clientY,a=r===this._sampleAnchorX&&i===this._sampleAnchorY;this._sampleClientX=e.clientX,this._sampleClientY=e.clientY,this._sampleAnchorX=r,this._sampleAnchorY=i,!(!a||r===this._anchorX&&i===this._anchorY)&&(this._anchorX=r,this._anchorY=i,this._chromeInsetX=r-(window.screenX||0),this._chromeInsetY=i-(window.screenY||0),this._publishScreenGeometry())}_streamBox(){let e=this._sinkBox(document.getElementById(`videoCanvas`),document.getElementById(`stream`));if(e)return{left:e.boxLeft,top:e.boxTop,width:e.boxW,height:e.boxH,scaleX:e.sinkW/e.boxW,scaleY:e.sinkH/e.boxH};if(this.m||this._windowMath(),!this.m)return null;let t=this._inputDpr();return{left:this.m.elementClientX+this.m.mouseOffsetX,top:this.m.elementClientY+this.m.mouseOffsetY,width:this.m.frameW/this.m.mouseMultiX,height:this.m.frameH/this.m.mouseMultiY,scaleX:this.m.mouseMultiX*t,scaleY:this.m.mouseMultiY*t}}_screenStreamBox(){if(this._chromeInsetX==null)return null;let e=this._streamBox();return!e||!(e.scaleX>0)||!(e.scaleY>0)?null:{originX:(window.screenX||0)+this._chromeInsetX+e.left,originY:(window.screenY||0)+this._chromeInsetY+e.top,scaleX:e.scaleX,scaleY:e.scaleY}}_publishScreenGeometry(){if(!this._layout||this.isSharedMode)return;let e=this._screenStreamBox();if(!e)return;let t=this._layout.own;Math.abs(t.originX-e.originX)<1&&Math.abs(t.originY-e.originY)<1&&Math.abs(t.scaleX-e.scaleX)<.001&&Math.abs(t.scaleY-e.scaleY)<.001||this.send(`vp,${e.originX.toFixed(2)},${e.originY.toFixed(2)},${e.scaleX.toFixed(4)},${e.scaleY.toFixed(4)}`)}_watchScreenGeometry(e){e&&!this._geometryTimer?(this._geometryTimer=setInterval(()=>this._publishScreenGeometry(),1e3),this._publishScreenGeometry()):!e&&this._geometryTimer&&(clearInterval(this._geometryTimer),this._geometryTimer=null)}_applySinkCoordinates(e,t,n,r,i,a){let o=this._sinkBox(n,r);if(!o)return!1;let s=o.sinkW/o.boxW,c=o.sinkH/o.boxH,l=(e-o.boxLeft)*s,u=(t-o.boxTop)*c;return this._mapToLayout(l,u,s,c,i,a)?!0:(this.x=Math.max(0,Math.min(o.sinkW,Math.round(l))),this.y=Math.max(0,Math.min(o.sinkH,Math.round(u))),!0)}setDisplayLayouts(e,t){if(this._layout=null,!e||typeof e!=`object`){this._watchScreenGeometry(!1);return}let n=[],r=null;for(let i in e){let a=e[i];if(!a)continue;let o=Number(a.x),s=Number(a.y),c=Number(a.w),l=Number(a.h);if(!Number.isFinite(o)||!Number.isFinite(s)||!(c>0)||!(l>0))continue;let u=Number(a.scale),d={x:o,y:s,w:c,h:l,scale:Number.isFinite(u)&&u>0?u:0,originX:0,originY:0,scaleX:0,scaleY:0},f=Number(a.originX),p=Number(a.originY),m=Number(a.scaleX),h=Number(a.scaleY);Number.isFinite(f)&&Number.isFinite(p)&&m>0&&h>0&&(d.originX=f,d.originY=p,d.scaleX=m,d.scaleY=h),n.push(d),i===t&&(r=d)}if(!r||n.length<2){this._watchScreenGeometry(!1);return}for(let e=0;e<n.length;e++){let t=n[e];t.crossable=t!==r&&!this._boxesOverlap(r,t)}this._layout={own:r,rects:n,ownX:r.x,ownY:r.y,ownW:r.w,ownH:r.h},this._watchScreenGeometry(!0)}_boxesOverlap(e,t){return!(e.scaleX>0)||!(e.scaleY>0)||!(t.scaleX>0)||!(t.scaleY>0)?!1:e.originX+1<t.originX+t.w/t.scaleX&&t.originX+1<e.originX+e.w/e.scaleX&&e.originY+1<t.originY+t.h/t.scaleY&&t.originY+1<e.originY+e.h/e.scaleY}_overNeighbor(e,t,n){return!e.crossable||!(e.scaleX>0)||!(e.scaleY>0)||!Number.isFinite(t)||!Number.isFinite(n)?!1:t>=e.originX&&t<=e.originX+e.w/e.scaleX&&n>=e.originY&&n<=e.originY+e.h/e.scaleY}_mapToLayout(e,t,n,r,i,a){let o=this._layout;if(!o||e>=0&&e<=o.ownW&&t>=0&&t<=o.ownH)return!1;let s=o.ownX+e,c=o.ownY+t,l=null,u=1/0;for(let e=0;e<o.rects.length;e++){let t=o.rects[e];if(t===o.own)continue;let n=s<t.x?t.x-s:s>t.x+t.w?s-(t.x+t.w):0,r=c<t.y?t.y-c:c>t.y+t.h?c-(t.y+t.h):0,i=n*n+r*r;i<u&&(u=i,l=t)}if(l&&this._overNeighbor(l,i,a))s=l.x+(i-l.originX)*l.scaleX,c=l.y+(a-l.originY)*l.scaleY;else if(l&&l.scale>0&&n>0&&r>0){let i=l.scale/n,a=l.scale/r;e>o.ownW?s=o.ownX+o.ownW+(e-o.ownW)*i:e<0&&(s=o.ownX+e*i),t>o.ownH?c=o.ownY+o.ownH+(t-o.ownH)*a:t<0&&(c=o.ownY+t*a)}let d=s,f=c;u=1/0;for(let e=0;e<o.rects.length;e++){let t=o.rects[e],n=t.x+t.w-1,r=t.y+t.h-1,i=s<t.x?t.x:s>n?n:s,a=c<t.y?t.y:c>r?r:c,l=s-i,p=c-a,m=l*l+p*p;m<u&&(u=m,d=i,f=a)}return this.x=Math.round(d-o.ownX),this.y=Math.round(f-o.ownY),!0}_inputDpr(){return window.manual_resolution||window.manualResolution||this.isSharedMode?1:this._streamDensity||(this.useCssScaling?1:window.devicePixelRatio||1)}_cursorDensity(){let e=this._sinkBox(document.getElementById(`videoCanvas`),document.getElementById(`stream`),!0);return e?Math.max(e.sinkW/e.boxW,e.sinkH/e.boxH):this._streamDensity?this._streamDensity:this.useCssScaling?1:window.devicePixelRatio||1}_refreshCursorScale(){let e=this._cursorDensity();e!==this._lastCursorDensity&&(this._lastCursorDensity=e,this.inputAttached&&(this.use_browser_cursors&&!this._trackpadMode?this._updateBrowserCursor():this._drawAndScaleCursor()))}_watchCursorScale(){typeof ResizeObserver<`u`&&(this._cursorResizeObserver=new ResizeObserver(()=>this._refreshCursorScale()),this._cursorResizeObserver.observe(this.element)),typeof MutationObserver<`u`&&(this._cursorMutationObserver=new MutationObserver(()=>this._refreshCursorScale())),this.listeners.push(B(window,`resize`,this._refreshCursorScale,this));for(let e of[`stream`,`videoCanvas`]){let t=document.getElementById(e);t&&(this._cursorResizeObserver&&this._cursorResizeObserver.observe(t),this._cursorMutationObserver&&this._cursorMutationObserver.observe(t,{attributes:!0,attributeFilter:[`width`,`height`,`style`]}),this.listeners.push(B(t,`resize`,this._refreshCursorScale,this)),this.listeners.push(B(t,`loadedmetadata`,this._refreshCursorScale,this)))}this._refreshCursorScale()}setStreamDensity(e){let t=Number.isFinite(e)&&e>0?e:null;this._streamDensity!==t&&(this._streamDensity=t,this._windowMath(),this._refreshCursorScale())}_pointerScale(){if(this._pointerScaleFrame)return this._pointerScaleFrame;let e=this._streamBox(),t=e?{x:e.scaleX,y:e.scaleY}:{x:this._inputDpr(),y:this._inputDpr()};return typeof window.requestAnimationFrame==`function`&&(this._pointerScaleFrame=t,window.requestAnimationFrame(()=>{this._pointerScaleFrame=null})),t}_quantizeRelative(e,t){if(this._relCarryX+=e,this._relCarryY+=t,!Number.isFinite(this._relCarryX)||!Number.isFinite(this._relCarryY))return this._relCarryX=0,this._relCarryY=0,[0,0];let n=Math.round(this._relCarryX),r=Math.round(this._relCarryY);return this._relCarryX-=n,this._relCarryY-=r,[n,r]}_relativeToServer(e,t){let n=this._pointerScale();return this._quantizeRelative(e*n.x,t*n.y)}_calculateTouchCoordinates(e){this._noteScreenAnchor(e),this._updateCursorPosition(e.clientX,e.clientY),this._latestMouseX=e.clientX,this._latestMouseY=e.clientY;let t=this._inputDpr(),n=document.getElementById(`videoCanvas`),r=document.getElementById(`stream`);if(!this._applySinkCoordinates(e.clientX,e.clientY,n,r,e.screenX,e.screenY)){if(this.m||this._windowMath(),this.m){let n=this._clientToServerX(e.clientX)*t,r=this._clientToServerY(e.clientY)*t;this._mapToLayout(n,r,this.m.mouseMultiX*t,this.m.mouseMultiY*t,e.screenX,e.screenY)||(this.x=Math.round(n),this.y=Math.round(r))}else this.x=Math.round(e.clientX*t),this.y=Math.round(e.clientY*t)}}_sendMouseState(){if(this._flushCoalescedMouseMove(),this._isStreamLocked()){this._sendPointer([`m2`,0,0,this.buttonMask,0],!1);return}this._sendPointer([`m`,this.x,this.y,this.buttonMask,0],!1)}setTrackpadMode(e){let t=!!e;this._trackpadMode!==t&&(console.log(`Input: Trackpad mode ${t?`enabled`:`disabled`}.`),this._trackpadMode=t,t?this._startPointerEcho():this._stopPointerEcho(),this._activeTouches.clear(),this._activeTouchIdentifier=null,this._isTwoFingerGesture=!1,this._twoFinger=null,this._longPressTimer&&(clearTimeout(this._longPressTimer),this._longPressTimer=null,this._longPressTouchIdentifier=null),clearTimeout(this._trackpadReleaseTimer),this._trackpadReleaseTimer=null,this._trackpadTouches.clear(),this._trackpadGestureMode=null,this.buttonMask!==0&&(this.buttonMask=0,this._sendMouseState()),this._trackpadMode?(this.element.style.setProperty(`cursor`,`none`,`important`),this.element.style.cursor=`default`):this.use_browser_cursors?(this.cursorDiv.style.display=`none`,this._updateBrowserCursor()):(this.element.style.setProperty(`cursor`,`none`,`important`),this.cursorDiv.style.display=`none`))}resumePointerEcho(){this._trackpadMode&&this._startPointerEcho()}_startPointerEcho(){this._echo=null,this._echoDeltas=[],this._placeEchoCursor(),!this._echoAsking&&(this._echoAsking=!0,queueMicrotask(()=>{this._echoAsking=!1,this._trackpadMode&&(this.send(`_pointer_echo,1`),clearTimeout(this._echoTimer),this._echoTimer=setTimeout(()=>{this._echoTimer=null,this._trackpadMode&&!this._echo&&this._compositeCursor()},ft),!this._cursorImageBitmap&&this._cursorBase64Data&&this._cursorBitmapFromBase64(this._cursorBase64Data).then(e=>{!this._cursorImageBitmap&&this._trackpadMode&&(this._cursorImageBitmap=e,this._drawAndScaleCursor())},()=>{}))}))}_stopPointerEcho(){clearTimeout(this._echoTimer),this._echoTimer=null,this._echo=null,this._echoDeltas=[],this.send(`_pointer_echo,0`),this._echoComposited&&(this._echoComposited=!1,this.send(`SET_NATIVE_CURSOR_RENDERING,0`))}_compositeCursor(){this._echoComposited=!0,this._echoDeltas=[],this.send(`SET_NATIVE_CURSOR_RENDERING,1`),this._placeEchoCursor()}onPointerEcho(e){if(!this._trackpadMode)return;let t=e.split(`,`);if(t[1]===`none`){clearTimeout(this._echoTimer),this._echoTimer=null,this._compositeCursor();return}let[n,r,i,a]=t.slice(2,6).map(Number);t.length<6||![n,r,i,a].every(Number.isFinite)||(clearTimeout(this._echoTimer),this._echoTimer=null,this._echoComposited&&(this._echoComposited=!1,this.send(`SET_NATIVE_CURSOR_RENDERING,0`)),this._echo={display:t[1],x:n,y:r,scale:i>0?i:1,seq:a,maxX:1/0,maxY:1/0},this._echoDeltas=this._echoDeltas.filter(e=>e[0]>a),this._placeEchoCursor())}_echoStep(e,t,n,r){let i=this._echo;return[Math.min(Math.max(e+n*i.scale,0),i.maxX),Math.min(Math.max(t+r*i.scale,0),i.maxY)]}_placeEchoCursor(){let e=this._echo,t=this._trackpadMode&&e&&!this._echoComposited&&this.inputAttached&&this._cursorImageBitmap&&e.display===this.displayId?this._streamBox():null;if(!t||!(t.scaleX>0)||!(t.scaleY>0)){this.cursorDiv.style.display!==`none`&&(this.cursorDiv.style.display=`none`);return}e.maxX=Math.max(0,t.width*t.scaleX-1),e.maxY=Math.max(0,t.height*t.scaleY-1);let n=e.x,r=e.y;for(let[,e,t]of this._echoDeltas)[n,r]=this._echoStep(n,r,e,t);this.cursorDiv.style.display!==`block`&&(this.cursorDiv.style.display=`block`),this._updateCursorPosition(t.left+n/t.scaleX,t.top+r/t.scaleY)}setRawPointerMotion(t){let n=!!t;if(e.rawPointerMotion===n||(e.rawPointerMotion=n,console.log(`Input: Raw pointer motion ${n?`enabled`:`disabled`}.`),typeof document>`u`||!this._isStreamLocked()))return;let r=document.pointerLockElement;this._requestPointerLock(r,()=>{document.pointerLockElement===r&&this._requestPointerLock(r,()=>{},()=>{})},e=>{console.warn(`Input: pointer lock did not take the raw motion change:`,e)})}setShortcutsEnabled(e){this.shortcutsEnabled=!!e}setMacCmdAsCtrl(t){let n=!!t;if(e.macCmdAsCtrl!==n){e.macCmdAsCtrl=n,console.log(`Input: macOS Command sent as ${n?`Control`:`Super`}.`);for(let e of[`MetaLeft`,`MetaRight`])this._keyDownList[e]===P.XK_Control_L&&this._sendKeyEvent(P.XK_Control_L,e,!1)}}async setUseBrowserCursors(e){let t=!!e;this.use_browser_cursors!==t&&(console.log(`Input: Use browser cursors ${t?`enabled`:`disabled`}.`),this.use_browser_cursors=t,this._trackpadMode?this.element.style.setProperty(`cursor`,`none`,`important`):this.use_browser_cursors?(this.cursorDiv.style.display=`none`,this._updateBrowserCursor()):(this.element.style.setProperty(`cursor`,`none`,`important`),this._cursorBase64Data&&!this._cursorImageBitmap&&(this._cursorImageBitmap=await this._cursorBitmapFromBase64(this._cursorBase64Data)),this._cursorImageBitmap?(this.cursorDiv.style.display=`block`,this._drawAndScaleCursor()):this.cursorDiv.style.display=`none`))}_handleTouchEvent(e){if(this._trackpadMode){this._handleTrackpadEvent(e);return}if(this._targetHasClass(e.target,j))return;if(z(e.changedTouches)){this.element.contains(e.target)&&e.preventDefault();return}if(!this._guac_markEvent(e))return;let t=e.type,n=Date.now(),r=!1,i=!1,a=this._TAP_THRESHOLD_DISTANCE_SQ;if(t===`touchstart`){this.use_browser_cursors||(this.cursorDiv.style.display=`block`);for(let t=0;t<e.changedTouches.length;t++){let r=e.changedTouches[t];this._activeTouches.has(r.identifier)||(this._activeTouches.set(r.identifier,{startX:r.clientX,startY:r.clientY,currentX:r.clientX,currentY:r.clientY,startTime:n,identifier:r.identifier,longPressCompleted:!1}),t===0&&this._calculateTouchCoordinates(r))}let t=this._activeTouches.size;if(t===1&&!this._isTwoFingerGesture){r=!0;let[e]=this._activeTouches.keys(),t=this._activeTouches.get(e),n={clientX:t.currentX,clientY:t.currentY};this._calculateTouchCoordinates(n);let i=this.x,a=this.y;t&&!t.longPressCompleted&&(this._longPressTouchIdentifier=e,this._longPressTimer&&clearTimeout(this._longPressTimer),this._longPressTimer=setTimeout(()=>{let e=this._activeTouches.get(this._longPressTouchIdentifier);if(e&&this._activeTouches.size===1&&this._longPressTouchIdentifier===e.identifier&&!this._isTwoFingerGesture&&this._activeTouchIdentifier===null&&!e.longPressCompleted){let t=e.currentX-e.startX,n=e.currentY-e.startY;t*t+n*n<225&&(e.longPressCompleted=!0,this.x=i,this.y=a,this.buttonMask|=4,this._sendMouseState(),setTimeout(()=>{this.buttonMask&4&&(this.buttonMask&=-5,this._sendMouseState())},50))}this._longPressTimer=null},750))}else{if(this._longPressTimer&&=(clearTimeout(this._longPressTimer),null),t===2){this.use_browser_cursors||(this.cursorDiv.style.visibility=`hidden`),this._isTwoFingerGesture=!0,this._activeTouchIdentifier=null;let[e,t]=this._activeTouches.values();this._twoFingerStart(e.currentX,e.currentY,t.currentX,t.currentY),(this.buttonMask&1)==1&&(this.buttonMask&=-2),r=!0}else t>2&&(this._isTwoFingerGesture&&=!1,this._activeTouchIdentifier!==null&&(this.buttonMask&=-2,this._sendMouseState(),this._activeTouchIdentifier=null));t!==1&&(this._longPressTouchIdentifier=null)}}else if(t===`touchmove`)for(let t=0;t<e.changedTouches.length;t++){let n=e.changedTouches[t],r=this._activeTouches.get(n.identifier);if(r&&(r.currentX=n.clientX,r.currentY=n.clientY,this._longPressTimer&&n.identifier===this._longPressTouchIdentifier)){let e=r.currentX-r.startX,t=r.currentY-r.startY;e*e+t*t>=225&&(clearTimeout(this._longPressTimer),this._longPressTimer=null)}}if(this._isTwoFingerGesture&&this._activeTouches.size===2){r=!0;let[e,t]=this._activeTouches.values();this._twoFingerMove(e.currentX,e.currentY,t.currentX,t.currentY)}else if(this._activeTouches.size===1){let[e]=this._activeTouches.keys(),t=this._activeTouches.get(e);if(this._activeTouchIdentifier===e)this._calculateTouchCoordinates({clientX:t.currentX,clientY:t.currentY}),this._sendMouseState(),i=!0,r=!0;else if(this._activeTouchIdentifier===null&&!t.longPressCompleted){let n=t.currentX-t.startX,o=t.currentY-t.startY;n*n+o*o>=a?(this._longPressTimer&&e===this._longPressTouchIdentifier&&(clearTimeout(this._longPressTimer),this._longPressTimer=null),this._activeTouchIdentifier=e,this._calculateTouchCoordinates({clientX:t.currentX,clientY:t.currentY}),this.buttonMask|=1,this._sendMouseState(),i=!0,r=!0):r=!0}}if(this._activeTouchIdentifier!==null&&!i&&this._activeTouches.size>0)r=!0;else if(t===`touchend`||t===`touchcancel`){let t=e.changedTouches;for(let e=0;e<t.length;e++){let i=t[e],o=i.identifier,s=this._activeTouches.get(o);if(!s)continue;if(this._longPressTimer&&o===this._longPressTouchIdentifier&&(clearTimeout(this._longPressTimer),this._longPressTimer=null),s.longPressCompleted){this._activeTouches.delete(o),o===this._longPressTouchIdentifier&&(this._longPressTouchIdentifier=null),r=!0;continue}s.currentX=i.clientX,s.currentY=i.clientY;let c=n-s.startTime,l=s.currentX-s.startX,u=s.currentY-s.startY,d=l*l+u*u;this._isTwoFingerGesture||(this._activeTouchIdentifier===null&&this._activeTouches.size===1&&this._activeTouches.has(o)?c<this._TAP_MAX_DURATION&&d<a&&(this._calculateTouchCoordinates(i),this.buttonMask|=1,this._sendMouseState(),r=!0,setTimeout(()=>{this.buttonMask&=-2,this._sendMouseState()},10)):o===this._activeTouchIdentifier&&(this._calculateTouchCoordinates(i),this.buttonMask&=-2,this._sendMouseState(),this._activeTouchIdentifier=null,r=!0)),this._activeTouches.delete(o),o===this._longPressTouchIdentifier&&(this._longPressTouchIdentifier=null)}{let e=this._activeTouches.size;if(this._isTwoFingerGesture&&e<2&&(!this._trackpadMode&&!this.use_browser_cursors&&(this.cursorDiv.style.visibility=`visible`),this._isTwoFingerGesture=!1,this._twoFinger=null),e===0&&(this._activeTouchIdentifier=null,this._isTwoFingerGesture=!1,this._twoFinger=null,this._longPressTimer&&=(clearTimeout(this._longPressTimer),null),this._longPressTouchIdentifier=null),e>0&&this._longPressTouchIdentifier&&!this._activeTouches.has(this._longPressTouchIdentifier)&&(this._longPressTimer&&clearTimeout(this._longPressTimer),this._longPressTimer=null,this._longPressTouchIdentifier=null),e===1){let[e]=this._activeTouches.keys();if(this._longPressTouchIdentifier!==e){this._longPressTimer&&clearTimeout(this._longPressTimer),this._longPressTimer=null,this._longPressTouchIdentifier=null;let t=this._activeTouches.get(e);if(t&&!t.longPressCompleted){let n={clientX:t.currentX,clientY:t.currentY,identifier:e};this._calculateTouchCoordinates(n);let r=this.x,i=this.y;this._longPressTouchIdentifier=e,this._longPressTimer=setTimeout(()=>{let e=this._activeTouches.get(this._longPressTouchIdentifier);if(e&&this._activeTouches.size===1&&this._longPressTouchIdentifier===e.identifier&&!this._isTwoFingerGesture&&this._activeTouchIdentifier===null&&!e.longPressCompleted){let t=e.currentX-e.startX,n=e.currentY-e.startY;t*t+n*n<225&&(e.longPressCompleted=!0,this.x=r,this.y=i,this.buttonMask|=4,this._sendMouseState(),setTimeout(()=>{this.buttonMask&4&&(this.buttonMask&=-5,this._sendMouseState())},50))}this._longPressTimer=null},750)}}}else e!==1&&(this._longPressTimer&&clearTimeout(this._longPressTimer),this._longPressTimer=null,this._longPressTouchIdentifier=null)}}r&&this.element.contains(e.target)&&e.preventDefault()}_twoFingerStart(e,t,n,r){let i=(e+n)/2,a=(t+r)/2,o=Math.hypot(e-n,t-r);this._twoFinger={x:i,y:a,x0:i,y0:a,span:o,span0:o,kind:null,rail:null,accX:0,accY:0,zoom:0}}_twoFingerMove(e,t,n,r){let i=this._twoFinger;if(!i)return;let a=(e+n)/2,o=(t+r)/2,s=Math.hypot(e-n,t-r);if(i.kind===null){let e=Math.abs(a-i.x0),t=Math.abs(o-i.y0),n=Math.hypot(e,t),r=Math.abs(s-i.span0);if(Math.max(n,r)<_t)return;r>n?i.kind=`pinch`:(i.kind=`scroll`,i.rail=t>=2*e?`y`:e>=2*t?`x`:`xy`)}if(i.kind===`pinch`){i.span>0&&s>0&&(i.zoom+=Math.log(s/i.span)/Math.log(vt)),i.span=s;let e=Math.trunc(i.zoom);i.zoom-=e,this._sendZoomNotches(e);return}i.rail!==`x`&&(i.accY+=i.y-o),i.rail!==`y`&&(i.accX+=i.x-a),i.x=a,i.y=o,i.accY=this._drainScrollNotches(i.accY,!0),i.accX=this._drainScrollNotches(i.accX,!1)}_drainScrollNotches(e,t){let n=Math.trunc(e/gt);if(n===0)return e;let r=e-n*gt,i=t?n>0?`down`:`up`:n>0?`right`:`left`;for(n=Math.abs(n);n>0;){let e=Math.min(n,this._scrollMagnitude);t?this._triggerMouseWheel(i,e):this._triggerHorizontalMouseWheel(i,e),n-=e}return r}_sendZoomNotches(e){if(e===0)return;let t=P.XK_Control_L,n=!this._keysymHeld(t,P.XK_Control_R);n&&this.send(`kd,`+t);let r=Math.abs(e);for(;r>0;){let t=Math.min(r,this._scrollMagnitude);this._triggerMouseWheel(e>0?`up`:`down`,t),r-=t}n&&this.send(`ku,`+t)}_triggerMouseWheel(e,t){t=Math.max(1,Math.round(t));let n=1<<(e===`up`?4:3),r=this.buttonMask&~n;this._sendPointer([`m2`,0,0,r,t],!1),this._sendPointer([`m2`,0,0,r|n,t],!1),this._sendPointer([`m2`,0,0,this.buttonMask,t],!1)}_triggerHorizontalMouseWheel(e,t){t=Math.max(1,Math.round(t));let n=1<<(e===`left`?6:7);this._sendPointer([`m2`,0,0,this.buttonMask|n,t],!1),this._sendPointer([`m2`,0,0,this.buttonMask,t],!1)}_isDiscreteWheel(){for(var e=[];!this._queue.isEmpty();){var t=this._queue.dequeue();t>0&&e.push(t)}if(e.length<2)return!0;var n=Math.min.apply(null,e);if(n<N)return!1;for(var r=0;r<e.length;r++){var i=e[r]/n;if(Math.abs(i-Math.round(i))>.15)return!1}return!0}_isDetentWheel(e){return I.isMacDesktop()?e.deltaMode===0?I.isFirefox()?!1:Number.isInteger(e.deltaX)&&Number.isInteger(e.deltaY)?e.shiftKey&&e.deltaY===0&&e.deltaX!==0&&e.deltaX%lt===0:!0:e.deltaMode===1:!1}_webKitGtkWheelNotches(e){if(e.deltaMode!==0||!I.isSafari()||!I.isLinux())return null;let t=[window.innerHeight,window.innerWidth].map(e=>Math.floor(e**(2/3))),n=(e,n)=>{if(!e&&!n)return 0;if(!e||!n||Math.sign(e)===Math.sign(n))return null;let r=Math.abs(n)/ut,i=Math.abs(e)/r;return t.some(e=>e>0&&Math.abs(i-e)<=1)?Math.sign(e)*r:null},r=n(e.deltaY,e.wheelDeltaY),i=n(e.deltaX,e.wheelDeltaX);return i===null||r===null||!i&&!r?null:{x:i,y:r}}_addWheelNotches(e,t){if(e){let t=e<0?`up`:`down`;t!==this._wheelDirY&&(this._wheelAccumY=0,this._wheelDirY=t),this._wheelAccumY+=Math.abs(e),this._emitWheelY()}if(t){let e=t<0?`left`:`right`;e!==this._wheelDirX&&(this._wheelAccumX=0,this._wheelDirX=e),this._wheelAccumX+=Math.abs(t),this._emitWheelX()}}_resetWheelLearning(){for(this._smallestDeltaY=1e4,this._smallestLineDeltaY=1e4,this._allowThreshold=!0,this._wheelClassified=!1;!this._queue.isEmpty();)this._queue.dequeue();this._wheelAccumY=0,this._wheelDirY=null,this._wheelAccumX=0,this._wheelDirX=null,this._pinchCarry=0}_mouseWheelWrapper(e){let t=performance.now();if(t-this._lastWheelEventTs>1e3&&this._resetWheelLearning(),this._lastWheelEventTs=t,e.ctrlKey&&!this._keysymHeld(P.XK_Control_L,P.XK_Control_R)){this._pinchWheel(e),e.preventDefault();return}if(this._isDetentWheel(e)){e.deltaY!==0&&this._triggerMouseWheel(e.deltaY<0?`up`:`down`,1),e.deltaX!==0&&this._triggerHorizontalMouseWheel(e.deltaX<0?`left`:`right`,1),e.preventDefault();return}let n=this._webKitGtkWheelNotches(e);if(n){this._addWheelNotches(n.y,n.x),e.preventDefault();return}if(e.deltaMode!==0){this._mouseWheel(e),e.preventDefault();return}var r=Math.trunc(Math.abs(e.deltaY));r!==0&&this._queue.size()<4&&this._queue.enqueue(r),this._queue.size()==4&&(this._allowThreshold=!this._isDiscreteWheel(),this._wheelClassified=!0),this._mouseWheel(e),e.preventDefault()}_wheelNotches(e,t){let n=Math.abs(Math.trunc(e));return n===0?0:t===1?(n<this._smallestLineDeltaY&&(this._smallestLineDeltaY=n),n/this._smallestLineDeltaY):t===2?Math.max(1,n):(n<this._smallestDeltaY&&(this._smallestDeltaY=n),this._allowThreshold?n/100:n/this._smallestDeltaY)}_wheelNotchesX(e,t){let n=Math.abs(e);return n===0?0:t===0?n/100:n}_accumulateWheelY(e){if(e.deltaY===0)return;let t=e.deltaY<0?`up`:`down`;t!==this._wheelDirY&&(this._wheelAccumY=0,this._wheelDirY=t),this._wheelAccumY+=this._wheelNotches(e.deltaY,e.deltaMode)}_accumulateWheelX(e){if(e.deltaX===0)return;let t=e.deltaX<0?`left`:`right`;t!==this._wheelDirX&&(this._wheelAccumX=0,this._wheelDirX=t),this._wheelAccumX+=this._wheelNotchesX(e.deltaX,e.deltaMode)}_emitWheelY(){let e=Math.floor(this._wheelAccumY);if(!(e<1))for(this._wheelAccumY-=e;e>0;){let t=Math.min(e,this._scrollMagnitude);this._triggerMouseWheel(this._wheelDirY,t),e-=t}}_emitWheelX(){let e=Math.floor(this._wheelAccumX);if(!(e<1))for(this._wheelAccumX-=e;e>0;){let t=Math.min(e,this._scrollMagnitude);this._triggerHorizontalMouseWheel(this._wheelDirX,t),e-=t}}_pinchWheel(e){let t;if(e.deltaMode===0&&Math.abs(e.deltaY)<yt)this._pinchCarry+=-e.deltaY/(100*Math.log(vt)),t=Math.trunc(this._pinchCarry),this._pinchCarry-=t;else{let n=this._wheelNotches(e.deltaY,e.deltaMode);t=-Math.sign(e.deltaY)*Math.max(1,Math.round(n))}this._sendZoomNotches(t)}setFingerScroll(e){let t=!!e;this.fingerScroll!==t&&(t||this._endFingerScroll(),this.fingerScroll=t)}_fingerScroll(e){let t=this._pointerScale(),n=e.deltaX*t.x,r=e.deltaY*t.y;(n!==0||r!==0)&&(this.send(`sf,${n.toFixed(2)},${r.toFixed(2)}`),clearTimeout(this._fingerScrollTimer),this._fingerScrollTimer=setTimeout(()=>this._endFingerScroll(),dt))}_endFingerScroll(){this._fingerScrollTimer!==null&&(clearTimeout(this._fingerScrollTimer),this._fingerScrollTimer=null,this.send(`sfe`))}_isFingerScroll(e){return!this.fingerScroll||e.deltaMode!==0?!1:this._fingerScrollTimer===null?this._wheelClassified?this._allowThreshold:Math.abs(e.deltaX)<N&&Math.abs(e.deltaY)<N:!0}_mouseWheel(e){if(this._isFingerScroll(e)){this._fingerScroll(e);return}this._accumulateWheelY(e),this._emitWheelY(),this._accumulateWheelX(e),this._emitWheelX()}_contextMenu(e){this.element.contains(e.target)&&e.preventDefault()}_streamLockTargets(){let e=[`videoCanvas`,`videoWorkerCanvas`,`videoStream`,`stream`].map(e=>document.getElementById(e));return e.push(this.element),e.filter(e=>e!=null)}_isStreamLocked(){let e=document.pointerLockElement;return e==null?!1:e===this.element||this._streamLockTargets().includes(e)}_pointerLock(){this._relCarryX=0,this._relCarryY=0,this._isStreamLocked()?(this.send(`p,1`),this.send(`SET_NATIVE_CURSOR_RENDERING,1`),this.cursorDiv.style.visibility=`hidden`):(this.send(`p,0`),this.send(`SET_NATIVE_CURSOR_RENDERING,0`),this.resetKeyboard(),this.cursorDiv.style.visibility=`visible`)}_windowMath(){this._pointerScaleFrame=null;let e=this.element.getBoundingClientRect(),t=e.width,n=e.height,r=this.element.offsetWidth,i=this.element.offsetHeight;if(t<=0||n<=0||r<=0||i<=0){this.m=null;return}let a=t/r,o=n/i,s=Math.min(a,o),c=r*s,l=i*s,u=(t-c)/2,d=(n-l)/2,f=c>0?r/c:1,p=l>0?i/l:1;this.m={mouseMultiX:f,mouseMultiY:p,mouseOffsetX:u,mouseOffsetY:d,elementClientX:e.left,elementClientY:e.top,frameW:r,frameH:i}}_clientToServerX(e){return this.m?(e-this.m.elementClientX-this.m.mouseOffsetX)*this.m.mouseMultiX:0}_clientToServerY(e){return this.m?(e-this.m.elementClientY-this.m.mouseOffsetY)*this.m.mouseMultiY:0}_encodeGamepadId(e){let t=String(e||`Gamepad`).replace(/[\u0100-\uffff]/g,`?`);try{return btoa(t)}catch{return btoa(`Gamepad`)}}_gamepadIndex(e=0){let t=this.controllerSlots,n=t?t[e]-1:e===0?this.playerIndex:null;return Number.isInteger(n)&&n>=0?n:null}_gamepadIndexOf(e){let t=this.gamepadManager?this.gamepadManager.drivenPosition(e):0;return t<0?null:this._gamepadIndex(t)}_gamepadConnected(e){this._gamepadIndex()!==null&&(this.gamepadManager||(this.gamepadManager=new Ze(e.gamepad,this._gamepadButton.bind(this),this._gamepadAxis.bind(this),this._gamepadHeartbeat.bind(this),this._gamepadActive.bind(this)),this.gamepadManager.setSlotCount(this.controllerSlots?this.controllerSlots.length:1),this.gamepadManager.setRumbleEnabled(this.gamepadRumble)),this.ongamepadconnected!==null&&this.ongamepadconnected(e.gamepad.id))}_gamepadActive(e,t,n=0){let r=this._gamepadIndex(n),i=this._gamepadAnnounced[n];delete this._gamepadAnnounced[n],i!==void 0&&(t||!e||i!==r)&&this.send(`js,d,`+i),e&&r!==null&&(this.send(`js,c,`+r+`,`+this._encodeGamepadId(e.id)+`,`+e.axes.length+`,`+e.buttons.length),this._gamepadAnnounced[n]=r)}_gamepadDisconnect(e){this.ongamepaddisconnected!==null&&this.ongamepaddisconnected(),this.gamepadManager&&e&&e.gamepad&&this.gamepadManager.padGone(e.gamepad.index)}_gamepadButton(e,t,n){let r=this._gamepadIndexOf(e);r!==null&&(this.send(`js,b,`+r+`,`+t+`,`+n),this._isSidebarOpen&&window.postMessage({type:`gamepadButtonUpdate`,gamepadIndex:r,buttonIndex:t,value:n},window.location.origin))}rumble(e,t,n,r){if(!this.gamepadManager)return;let i=this.controllerSlots;if(i&&i.length>1){let a=this.gamepadManager.drivers[i.indexOf(e+1)];a!=null&&this.gamepadManager.rumble(t,n,r,a);return}e===this._gamepadIndex()&&this.gamepadManager.rumble(t,n,r)}setGamepadRumble(e){this.gamepadRumble=!!e,this.gamepadManager&&this.gamepadManager.setRumbleEnabled(this.gamepadRumble)}stopRumble(){this.gamepadManager&&this.gamepadManager.stopRumble()}_gamepadHeartbeat(){let e=this.gamepadManager?this.gamepadManager.drivers.length:1;for(let t=0;t<e;t++){if(t>0&&this.gamepadManager.drivers[t]===null)continue;let e=this._gamepadIndex(t);e!==null&&this.send(`js,h,`+e)}}_gamepadAxis(e,t,n){let r=this._gamepadIndexOf(e);if(r!==null){if(navigator.userAgent.toLowerCase().includes(`firefox`)){if(t===4){let e=(n+1)/2;this.send(`js,b,`+r+`,6,`+e);return}if(t===5){let e=(n+1)/2;this.send(`js,b,`+r+`,7,`+e);return}}this.send(`js,a,`+r+`,`+t+`,`+n),this._isSidebarOpen&&window.postMessage({type:`gamepadAxisUpdate`,gamepadIndex:r,axisIndex:t,value:n},window.location.origin)}}_isStreamFullscreen(){let e=document.fullscreenElement;return e!==null&&e.contains(this.element)}_requestPointerLock(t,n,r){let i=e._asksRawMotion(),a=i?t.requestPointerLock({unadjustedMovement:!0}):t.requestPointerLock();a&&typeof a.catch==`function`&&a.catch(t=>{if(t&&t.name===`NotSupportedError`&&i){e._rawMotionRefused=!0,n();return}r(t)})}_armPointerLock(t=0,n=0){if(this.inputAttached&&this.gamingMode&&this._isStreamFullscreen()&&!this._isStreamLocked()){if(n<rt&&!e._viewportSettled()){requestAnimationFrame(()=>this._armPointerLock(t,n+1));return}this._requestPointerLock(this.element,()=>this._armPointerLock(t,n),e=>{t<5?setTimeout(()=>this._armPointerLock(t+1,n),60):console.warn(`Pointer lock failed on fullscreen:`,e)})}}_onFullscreenChange(){this._isStreamFullscreen()?this.inputAttached&&this.gamingMode&&(this._armPointerLock(),this.requestKeyboardLock()):(this._fullscreenKeyboardLock=!1,this._setGamingMode(!1),this._isStreamLocked()&&document.exitPointerLock()),this.send(`kr`),this.resetKeyboard()}_targetHasClass(e,t){let n=e;for(;n&&n.classList;){if(n.classList.contains(t))return!0;n=n.parentElement}return!1}getWindowResolution(){let e=document.body?document.body.offsetWidth:window.innerWidth,t=document.body?document.body.offsetHeight:window.innerHeight,n=window.devicePixelRatio||1,r=e*n,i=t*n;return[Math.max(1,parseInt(r-r%2)),Math.max(1,parseInt(i-i%2))]}resize(){this._windowMath()}isInputAttached(){return this.inputAttached}attach(){if(e._attachedInstance&&e._attachedInstance!==this)try{e._attachedInstance.detach()}catch{}if(e._attachedInstance=this,this._watchCursorScale(),this._focusCompositionHost(),this.listeners.push(B(this.element,`resize`,this._windowMath,this)),this.listeners.push(B(document,`pointerlockchange`,this._pointerLock,this)),this.listeners.push(B(document,`fullscreenchange`,this._onFullscreenChange,this)),this.listeners.push(B(window,`resize`,this._windowMath,this)),this.listeners.push(B(window,`resize`,this._placeEchoCursor,this)),this.listeners.push(B(window,`gamepadconnected`,this._gamepadConnected,this)),this.listeners.push(B(window,`gamepaddisconnected`,this._gamepadDisconnect,this)),this.listeners.push(B(window,`message`,this._handleVisibilityMessage,this)),this.listeners.push(B(window,`orientationchange`,()=>{setTimeout(()=>this._windowMath(),200),setTimeout(()=>this._windowMath(),500)},this)),!this.isSharedMode)this.attach_context();else{let e=e=>e.preventDefault();this.listeners.push(B(this.element,`touchstart`,e,this)),this.listeners.push(B(this.element,`touchend`,e,this)),this.listeners.push(B(this.element,`touchmove`,e,this)),this.listeners.push(B(this.element,`touchcancel`,e,this))}this.resyncGamepads()}attach_context(){if(this.inputAttached)return;this._windowMath(),this.element.style.setProperty(`cursor`,`none`,`important`),(this._cursorImageBitmap||this._cursorBase64Data)&&(this.use_browser_cursors?this._updateBrowserCursor():(this.cursorDiv.style.display=`block`,this._drawAndScaleCursor())),this.listeners_context.push(B(window,`keydown`,this._handleKeyDown,this,!0)),this.listeners_context.push(B(window,`keyup`,this._handleKeyUp,this,!0)),this.listeners_context.push(B(window,`blur`,this.resetKeyboard,this)),this.listeners_context.push(B(document,`visibilitychange`,this._onVisibilityChange,this)),this.listeners_context.push(B(window,`pagehide`,this.resetKeyboard,this)),this.listeners_context.push(B(document,`freeze`,this.resetKeyboard,this)),this.listeners_context.push(B(this.keyboardInputAssist,`input`,this._handleMobileInput,this)),this.listeners_context.push(B(this.keyboardInputAssist,`compositionstart`,this._assistCompositionStart,this)),this.listeners_context.push(B(this.keyboardInputAssist,`compositionend`,this._assistCompositionEnd,this)),this.listeners_context.push(B(this.keyboardInputAssist,`focus`,this._assistFocusChange,this)),this.listeners_context.push(B(this.keyboardInputAssist,`blur`,this._assistFocusChange,this)),this.listeners_context.push(B(document,`mousedown`,this._handleOutsideClick,this,!0)),this.listeners_context.push(B(document,`touchstart`,this._handleOutsideClick,this,!0)),this.listeners_context.push(B(this.element,`wheel`,this._mouseWheelWrapper,this)),this.listeners_context.push(B(this.element,`contextmenu`,this._contextMenu,this));let e=this.element;this.listeners_context.push(B(e,`compositionstart`,this._compositionStart,this)),this.listeners_context.push(B(e,`compositionupdate`,this._compositionUpdate,this)),this.listeners_context.push(B(e,`compositionend`,this._compositionEnd,this)),this.listeners_context.push(B(this.element,`textInput`,this._handleTextInput,this)),this.listeners_context.push(B(this.element,`pointerdown`,this._handlePointerDown,this)),this.listeners_context.push(B(this.element,`pointermove`,this._handlePointerMove,this)),this.listeners_context.push(B(this.element,`pointerup`,this._handlePointerUp,this)),this.listeners_context.push(B(this.element,`pointercancel`,this._handlePointerUp,this)),`ontouchstart`in window&&(this.listeners_context.push(B(this.element,`touchstart`,this._handleTouchEvent,this,!1)),this.listeners_context.push(B(this.element,`touchend`,this._handleTouchEvent,this,!1)),this.listeners_context.push(B(this.element,`touchmove`,this._handleTouchEvent,this,!1)),this.listeners_context.push(B(this.element,`touchcancel`,this._handleTouchEvent,this,!1))),this.listeners_context.push(B(this.element,`mousedown`,this._mouseButtonMovement,this)),`onpointerrawupdate`in window&&this.listeners_context.push(B(window,`pointerrawupdate`,this._handleRawPointerUpdate,this)),this.listeners_context.push(B(window,`mousemove`,this._mouseButtonMovement,this)),this.listeners_context.push(B(window,`mouseup`,this._mouseButtonMovement,this)),this.inputAttached=!0,this._isStreamFullscreen()&&this.gamingMode?(this._armPointerLock(),this.requestKeyboardLock()):this._isStreamLocked()&&this._pointerLock(),this._windowMath(),this._placeEchoCursor()}resyncGamepads(){if(this.gamepadManager){this._gamepadAnnounced={},this.gamepadManager.reannounce();return}let e;try{e=navigator.getGamepads?Array.from(navigator.getGamepads()):[]}catch{return}for(let t of e)if(t&&t.connected){this._gamepadConnected({gamepad:t});break}}detach(){e._attachedInstance===this&&(e._attachedInstance=null),this._cursorResizeObserver&&this._cursorResizeObserver.disconnect(),this._cursorMutationObserver&&this._cursorMutationObserver.disconnect(),this._lastCursorDensity=null,It(this.listeners),this.listeners=[],this.gamepadManager&&=(this.gamepadManager.destroy(),null),this._gamepadAnnounced={},this._watchScreenGeometry(!1),this.detach_context()}detach_context(){this._stopKeyHeartbeat(),It(this.listeners_context),this.listeners_context=[],this.element.style.cursor=`auto`,this.cursorDiv.style.display=`none`,this.send(`kr`),this.resetKeyboard(),this._activeTouches.clear(),this._activeTouchIdentifier=null,this._isTwoFingerGesture=!1,clearTimeout(this._trackpadReleaseTimer),this._trackpadReleaseTimer=null,this._trackpadTouches.clear(),this._trackpadGestureMode=null,this._pendingMove=null,this._rawMotionSeen=!1,this._endFingerScroll(),this._relCarryX=0,this._relCarryY=0,(this.buttonMask&1)==1&&(this.buttonMask&=-2,this._sendMouseState()),this.inputAttached=!1,this._exitPointerLock()}_exitPointerLock(){this._isStreamLocked()&&(document.exitPointerLock(),this.send(`p,0`),console.log(`remote pointer visibility to: False`))}enterFullscreen(){document.fullscreenElement===null&&document.documentElement.requestFullscreen().catch(e=>console.error(`Fullscreen request failed:`,e))}toggleGamingMode(){if(!this.gamingMode){this.enterGamingMode();return}document.fullscreenElement===null?this._setGamingMode(!1):document.exitFullscreen().catch(e=>console.error(`Fullscreen exit failed:`,e))}enterGamingMode(){if(this._setGamingMode(!0),document.fullscreenElement===null){document.documentElement.requestFullscreen(this._gamingFullscreenOptions()).catch(e=>{console.error(`Fullscreen request failed:`,e),this._setGamingMode(!1)});return}this._armPointerLock(),navigator.keyboard&&`lock`in navigator.keyboard||document.fullscreenElement.requestFullscreen(this._gamingFullscreenOptions()).catch(()=>{this._fullscreenKeyboardLock=!1,this.requestKeyboardLock()}),this.requestKeyboardLock()}_gamingFullscreenOptions(){this._fullscreenKeyboardLock=!1;let e=this;return{get keyboardLock(){return e._fullscreenKeyboardLock=!0,`browser`}}}_setGamingMode(e){this.gamingMode!==e&&(this.gamingMode=e,e||this.releaseKeyboardLock(),this.ongamingmode&&this.ongamingmode(e))}requestKeyboardLock(){if(this.gamingMode&&document.fullscreenElement){if(navigator.keyboard&&`lock`in navigator.keyboard){navigator.keyboard.lock().catch(()=>{});return}this._fullscreenKeyboardLock||this._noticeKeyboardLockUnavailable()}}_noticeKeyboardLockUnavailable(){if(e._keyboardLockNoticed)return;e._keyboardLockNoticed=!0;let t=typeof navigator<`u`&&!!navigator.brave,n=t?`keyboardLockBlockedByShields`:`keyboardLockUnavailable`,r=t?`Brave's Shields block the keyboard lock, so a single Escape leaves gaming mode. Allow the keyboard API for this site under the Shields fingerprinting controls to hold Escape instead.`:`This browser offers no keyboard lock, so a single Escape leaves gaming mode instead of reaching the session.`;console.warn(`Input: `+r),this.onnotice&&this.onnotice(n,r)}releaseKeyboardLock(){if(navigator.keyboard&&`unlock`in navigator.keyboard)try{navigator.keyboard.unlock()}catch{}}};et(Ft,`_nextGuacID`,0),et(Ft,`rawPointerMotion`,!I.isMacDesktop()),et(Ft,`macCmdAsCtrl`,!0),et(Ft,`_rawMotionRefused`,!1),et(Ft,`_keyboardLockNoticed`,!1),et(Ft,`_cursorImageSetFn`,void 0);function z(e){if(!e||e.length===0)return!1;for(let t=0;t<e.length;t++)if(e[t].touchType!==`stylus`)return!1;return!0}function B(e,t,n,r,i=!1){if(!e||typeof e.addEventListener!=`function`)return console.error(`addListener: Invalid target object`,e),null;let a=r?n.bind(r):n,o={capture:i,passive:!1};return e.addEventListener(t,a,o),[e,t,a,o]}function It(e){for(let t of e)t&&t[0]&&typeof t[0].removeEventListener==`function`&&t[0].removeEventListener(t[1],t[2],t[3]);e.length=0}function Lt({useCssScaling:e,localScale:t,manual:n,displayId:r,layouts:i,shared:a,wayland:o}){let s=window.devicePixelRatio||1,c=e&&!n?s/(Number.isFinite(t)&&t>0?t:1):s;if(o||a||n||!r||r===`primary`)return c;let l=Number(i&&i.primary&&i.primary.scale);return!(l>0)||l>=c?c:Math.round(l*100)/100}var Rt=[96,120,144,168,192,216,240,264,288],zt=1080;function Bt(e){return Rt.reduce((t,n)=>Math.abs(n-e)<Math.abs(t-e)?n:t)}function Vt(){let e=window.devicePixelRatio||1;return Bt(Math.round(e*4)*24)}function Ht(e,t){let n=Math.min(Number(e)||0,Number(t)||0);return n>0?Bt(96*n/zt):Vt()}function Ut({stream:e,css:t,realized:n,density:r}){return!e||!t||!n||!(t[0]>0)||!(t[1]>0)||e[0]!==n[0]||e[1]!==n[1]?r:Math.max(e[0]/t[0],e[1]/t[1])}function Wt(e,t){return{__clipDigest:!0,byteLength:e,hash:t}}async function Gt(e){let t=await createImageBitmap(e);try{let e=document.createElement(`canvas`);return e.width=t.width,e.height=t.height,e.getContext(`2d`).drawImage(t,0,0),await new Promise((t,n)=>e.toBlob(e=>e?t(e):n(Error(`PNG encode failed`)),`image/png`))}finally{t.close()}}function Kt(){return typeof navigator<`u`&&navigator.clipboard?null:typeof window<`u`&&window.isSecureContext===!1?`this page is not a secure context, so the browser exposes no clipboard (serve it over https, or from localhost)`:`this browser exposes no clipboard API`}var V=`application/x-selkies-clipboard-flavours`;function qt({html:e,text:t}){let n={"text/html":e};return t&&(n[`text/plain`]=t),new TextEncoder().encode(JSON.stringify(n)).buffer}function Jt(e){let t=JSON.parse(new TextDecoder().decode(e));return{html:t[`text/html`]||``,text:t[`text/plain`]||``}}function H(e){try{return new DOMParser().parseFromString(e,`text/html`).body.textContent||``}catch{return``}}async function U(e){let t=async()=>{let e=await navigator.clipboard.readText().catch(()=>``);return e?{kind:`text`,text:e}:null};if(!e){let e=await navigator.clipboard.readText();return e?{kind:`text`,text:e}:null}let n;try{n=await navigator.clipboard.read()}catch(e){if(e&&e.name===`DataError`)return t();throw e}if(!n||n.length===0)return null;let r=n[0],i=r.types.find(e=>e.startsWith(`image/`));try{let e=r.types.includes(`text/html`)?await(await r.getType(`text/html`)).text():``;if(i&&!H(e).trim())return{kind:`image`,blob:await r.getType(i),mime:i};if(e)return{kind:`flavours`,html:e,text:r.types.includes(`text/plain`)?await(await r.getType(`text/plain`)).text():``};if(r.types.includes(`text/plain`)){let e=await(await r.getType(`text/plain`)).text();return e?{kind:`text`,text:e}:null}}catch(e){if(e&&e.name===`DataError`)return t();throw e}return null}function Yt(e){let t=null,n=null,r=0,i=0,a=!1;function o(e){if(!e)return 0;let t=e.endsWith(`==`)?2:+!!e.endsWith(`=`);return e.length/4*3-t}function s(){t=null,n=null,r=0,i=0,a=!1}return{begin(i,o){this.reset(),n=i,r=o,t=e(i),a=!0},push(e){a&&(t.push(e),i+=o(e))},finish(){if(!a)return Promise.reject(Error(`no transfer in progress`));let e=t.finish();return s(),e},reset(){t&&t.abort(),s()},get inProgress(){return a},get mimeType(){return n},get totalSize(){return r},get receivedSize(){return i}}}function Xt(){let e=0,t=!1,n=!1;return{arm(){t=!0,n=!0,e=0},armLegacyWindow(t){e=Date.now()+t},consume(){if(n)return n=!1,!0;if(t||!e)return!1;let r=Date.now()<e;return e=0,r}}}var Zt=1e3,Qt=Symbol(`predates an explicit push`),$t=1e4,en=3e4;function tn({isChromium:e,isSharedMode:t,canSync:n,canRead:r,binaryEnabled:i,sendClipboardData:a,clipboardSync:o,getDeferredWriteInFlight:s=null}){let c=null,l=!1,u=!1,d=0,f=-1/0;function p(){return d>0||Date.now()-f<Zt}async function m(e){let t,n=new Promise(e=>{t=e});c=n;try{await e}finally{t(),c===n&&(c=null)}}async function h(){if(window.isSecureContext&&navigator.clipboard&&!t()&&n()&&r()){if(s){let e=Date.now()+$t;for(let t=0;t<2;t++){let t=s(),n=e-Date.now();if(!t||n<=0||(await Promise.race([t.catch(()=>{}),new Promise(e=>setTimeout(e,n))]),!s()))break}}await m((async()=>{try{let e=await U(i());if(!e)return;let t=e.text,n=`text/plain`;e.kind===`image`?(t=await e.blob.arrayBuffer(),n=e.mime):e.kind===`flavours`&&(t=qt(e),n=V);let r=await o.localSig(t,n);if(!o.noteLocal(r)||p())return;let s=null;if(await a(t,n,(e,t)=>{s=t||e}),s===`clipboardSkipNotConnected`||s===`clipboardSkipSendFailed`){o.forgetLocal(r),u=!0;return}if(s)return;console.log(`Sent the local clipboard (${n}) to the session`)}catch(e){e.name!==`NotFoundError`&&e.name!==`DataError`&&e.name!==`NotAllowedError`&&!(e.message&&e.message.includes(`not focused`))&&console.warn(`Could not read clipboard: ${e.name} - ${e.message}`)}})())}}async function g(e,t,n){d++,o.noteExplicit(),await m((async()=>{try{await a(e&&typeof e.arrayBuffer==`function`?await e.arrayBuffer():e,t,n)}finally{d--,f=Date.now()}})())}async function _(){if((!l||u)&&(l=!0,u=!1,e&&!t()&&document.hasFocus()&&navigator.permissions&&navigator.permissions.query))try{(await navigator.permissions.query({name:`clipboard-read`})).state===`granted`&&h()}catch{}}return{readAndSend:h,sendExplicit:g,maybeInitial:_,getSendInFlight:()=>c}}function nn(){let e=null,t=0,n=null;function r(e){return!!e&&(e.name===`NotAllowedError`||e.name===`SecurityError`)}function i(e,t){let r={promise:e,settled:!t.settled};t.settled&&t.settled.then(()=>{r.settled=!0},()=>{r.settled=!0}),n=r,e.finally(()=>{n===r&&(n=null)})}function a(n){return Promise.resolve().then(()=>n.attempt()).then(()=>Promise.resolve(n.onSuccess&&n.onSuccess()).then(()=>!0,()=>!0),i=>r(i)?(n.seq===t&&(e=n),!1):(n.onFailure&&!(i&&i.name===`AbortError`)&&n.onFailure(i),!1))}function o(){let t=e;t&&(e=null,i(a(t),t))}for(let e of[`pointerdown`,`keydown`,`focus`])window.addEventListener(e,o,!0);document.addEventListener(`visibilitychange`,()=>{document.hidden||o()},!0);function s(n,{onSuccess:r,onFailure:o,settled:s}={}){let c={attempt:n,onSuccess:r,onFailure:o,settled:s,seq:++t};e=null;let l=a(c);return i(l,c),l}return{write:s,flush:o,getInFlight:()=>n?n.promise:null,getLanding:()=>n&&n.settled?n.promise:null,hasPending:()=>!!e||!!n,issued:()=>t}}var rn=6e4;function an({isChromium:e,writer:t,onCleared:n}){let r=null;async function i(){let e=r;if(e&&e.due&&!e.busy){e.busy=!0;try{for(let e=t.getInFlight();e;e=t.getInFlight())await e.catch(()=>{});if(r!==e||t.hasPending()||!document.hasFocus())return;let i=await navigator.permissions.query({name:`clipboard-read`});if(i.state===`denied`&&(r=null),r!==e||i.state!==`granted`)return;let a=t.issued(),o=await navigator.clipboard.readText();if(r!==e)return;if(o!==e.text){r=null;return}if(t.issued()!==a)return;await navigator.clipboard.writeText(``),r===e&&(r=null),n()}catch{}finally{e.busy=!1}}}function a(e){clearTimeout(e.timer),e.due=!0,setTimeout(i,0)}return e&&typeof window<`u`&&window.addEventListener(`focus`,()=>{r&&r.due&&i()}),{landed(t){if(!e)return;r&&clearTimeout(r.timer);let n={text:t,due:!1,busy:!1,timer:null};n.timer=setTimeout(()=>a(n),rn),r=n},holds:e=>!!r&&r.text===e,retract(){r&&a(r)}}}function on({worker:e,clipboardSync:t,writer:n,toPng:r,canWriteLocal:i,binaryEnabled:a,onPreview:o,onImageWritten:s,onImageWriteFailed:c,isChromium:l=!1}){let u=Yt(t=>e.decodeStream(t)),d=null,f=0,p=null,m=null,h=!1,g=null,_=an({isChromium:l,writer:n,onCleared:()=>t.forget()});function ee(){clearTimeout(m),m=setTimeout(()=>{d&&=(console.warn(`Session clipboard transfer stalled; dropping it.`),oe(d.landing,`stalled`),u.reset(),null)},en)}function te(e){return e===`text/plain`?`text`:e===`application/x-selkies-clipboard-flavours`?`flavours`:typeof e==`string`&&e.startsWith(`image/`)?`image`:null}function ne(e,t){return!t&&i()&&(e!==`image`||a())}function re(){return typeof ClipboardItem<`u`&&typeof navigator<`u`&&!!navigator.clipboard&&!!navigator.clipboard.write}function ie(e){return new DOMException(e,`AbortError`)}function ae(){let e,t,n=new Promise((n,r)=>{e=n,t=r});return n.catch(()=>{}),{promise:n,resolve:e,reject:t}}function oe(e,t){if(!(!e||e.settled||e.withdrawn)){e.withdrawn=!0;for(let n of Object.values(e.parts))n.reject(ie(t))}}function v(e,r,i){oe(p,`superseded`);let a=e===`image`?[`image/png`]:e===`text`?[`text/plain`]:[`text/html`,`text/plain`],o={parts:{},settled:!1,withdrawn:!1,failed:null,localSig:null};for(let e of a)o.parts[e]=ae();let l=Promise.all(a.map(e=>o.parts[e].promise));return l.then(()=>{o.settled=!0},()=>{}),p=o,n.write(async()=>{let e={};for(let t of a)e[t]=o.parts[t].promise;try{await navigator.clipboard.write([new ClipboardItem(e)])}catch(e){throw o.withdrawn?ie(`withdrawn`):o.failed?o.failed:e}},{settled:l,onSuccess:e===`image`?()=>s(r):()=>{t.noteLocal(o.localSig),i&&_.landed(o.text)},onFailure:e===`image`?c:e=>console.error(`Could not copy the session clipboard to the local one: ${e&&e.name} - ${e&&e.message}`)}),o}function y(e,n,i){if(n===`image`){let t=e.parts[`image/png`];i.mime===`image/png`?t.resolve(i.blob):r(i.blob).catch(()=>Gt(i.blob)).then(t.resolve,n=>{e.failed=n,t.reject(n)})}else n===`text`?(e.localSig=t.sig(i.text),e.text=i.text,e.parts[`text/plain`].resolve(new Blob([i.text],{type:`text/plain`}))):(e.parts[`text/html`].resolve(new Blob([i.html],{type:`text/html`})),e.parts[`text/plain`].resolve(new Blob([i.text||H(i.html)],{type:`text/plain`})))}function b(e,n){if(e.gen!==f&&e.landing&&e.landing.withdrawn)return;let r,i;if(e.kind===`text`){let a=n.result;if(r=t.shouldSend(a,`text/plain`),t.resolveServer(a,null,`text/plain`),g=e.secret&&a?a:null,o(a,!!g),i={text:a},_.holds(a)&&e.secret?r||_.landed(a):_.retract(),e.secret&&!a){oe(e.landing,`retracted`);return}}else{g=null,_.retract();let a=Wt(n.byteLength,n.hash);if(r=t.shouldSend(a,e.mime),e.kind===`flavours`){let r=Jt(n.result);t.resolveServer(r.text||r.html,null,e.mime,a),o(r.text||r.html),i=r}else{let r=new Blob([n.result],{type:e.mime});t.resolveServer(void 0,r,e.mime,a),i={blob:r,mime:e.mime}}}if(!r||!ne(e.kind,e.cacheOnly)){oe(e.landing,`unchanged`);return}e.landing?y(e.landing,e.kind,i):re()?y(v(e.kind,e.mime,e.secret),e.kind,i):e.kind===`image`?c(Error(`the local clipboard takes no images here`)):typeof navigator<`u`&&navigator.clipboard&&x(e.kind===`text`?i.text:i.text||i.html,e.secret)}function x(e,r){return n.write(()=>navigator.clipboard.writeText(e),{onSuccess:()=>{t.noteLocal(t.sig(e)),r&&_.landed(e)},onFailure:e=>console.error(`Could not copy the session clipboard to the local one: ${e&&e.name}`)})}function se(e,t,n){let r=h;h=!1,d&&=(oe(d.landing,`superseded`),u.reset(),null);let i=te(e);return!i||i===`image`&&!a()?null:{kind:i,mime:e,cacheOnly:t,secret:i===`text`&&!!(n||r),gen:++f,landing:null}}return{begin(e,t,n,r){let i=se(e,n,r);i&&(u.begin(e,t),ne(i.kind,n)&&re()&&(!i.secret||t)&&(i.landing=v(i.kind,e,i.secret)),d=i,ee())},push(e){d&&(u.push(e),ee())},finish(){let e=d;if(d=null,clearTimeout(m),!e||!u.inProgress)return;let t=u.totalSize;if(u.receivedSize!==t){console.error(`Multipart clipboard size mismatch: received ${u.receivedSize} of ${t} bytes.`),u.reset(),oe(e.landing,`incomplete`);return}u.finish().then(n=>{if(n.byteLength!==t){oe(e.landing,`incomplete`);return}b(e,n)}).catch(t=>{oe(e.landing,`undecodable`),console.error(`Error assembling final clipboard content:`,t)})},single(t,n,r,i){let a=se(t,r,i);a&&e.decode(n,a.kind===`text`?`text/plain`:t).then(e=>b(a,e),e=>console.error(`Error processing clipboard data from the session:`,e))},markSecret(){h=!0},copySecret(){return!g||typeof navigator>`u`||!navigator.clipboard?Promise.resolve(!1):x(g,!0)},reset(){d&&oe(d.landing,`dropped`),h=!1,clearTimeout(m),u.reset(),d=null}}}var sn=262144;function cn(e,t=!1){let n=!t&&e.length>262144;return{type:`clipboardContentUpdate`,text:t?``:n?e.slice(0,sn):e,truncated:n,totalLength:t?0:e.length,secret:t}}function ln({sendRequest:e,digestBytes:t,isChromium:n=!0,canRead:r=()=>!0}){let i=``,a=null,o=`text/plain`,s=null,c=null,l=null,u=[];function d(e){s=e,c=null}function f(e,t){for(let n=0;n<t.length;n++)e=(e<<5)+e+t[n]|0;return e}function p(e,t){if(typeof e==`string`){let t=5381;for(let n=0;n<e.length;n++)t=(t<<5)+t+e.charCodeAt(n)|0;return{full:`t:${e.length}:${t}`,legacy:null}}if(e&&e.__clipDigest){let n=t||``;return{full:`b:${n}:${e.byteLength}:${e.hash}`,legacy:`b:${n}:${e.byteLength}`}}let n=null;e instanceof Uint8Array?n=[e]:e instanceof ArrayBuffer?n=[new Uint8Array(e)]:Array.isArray(e)&&(n=e.map(e=>e instanceof Uint8Array?e:new Uint8Array(e)));let r=t||``;if(n){let e=5381,t=0;for(let r of n)t+=r.length,e=f(e,r);return{full:`b:${r}:${t}:${e}`,legacy:`b:${r}:${t}`}}return{full:`b:${r}:${e&&(e.byteLength===void 0?e.size:e.byteLength)}`,legacy:null}}function m(e,t){return p(e,t).full}function h(e,t){let{full:n,legacy:r}=p(e,t);return n===s||n===c?!1:r===null||r!==s&&r!==c}function g(e,t){d(m(e,t))}async function _(e,n){return m(typeof e==`string`||!t?e:await t(e.slice(0)),n)}function ee(e){let t=l!==Qt&&(e===null||e!==l);return l=e,t}function te(){l=Qt}function ne(){d(null),l=null}function re(e){l===e&&(l=null)}function ie(e,t,n,r){if(typeof e==`string`&&(i=e,d(m(e))),t&&(a=t,d(m(r??t,n||t.type))),n&&(o=n),u.length===0)return;let s=u;u=[];for(let n of s)if(!n.settled)try{n.wantBinary?t&&t!==n.baselineBlob?n.resolve(t):u.push(n):typeof e==`string`&&e!==n.baselineText?n.resolve(e):u.push(n)}catch{}}async function ae(){if(!n||!r())return;let e=s;try{let n=await navigator.clipboard.read();for(let r of n){let n=r.types.find(e=>e!==`text/plain`);if(!n)continue;let i=await(await r.getType(n)).arrayBuffer(),a=m((t?await t(i):null)||new Uint8Array(i),n);s===e&&(c=a,l=a);return}}catch{}}function oe(t){try{e()}catch{}return new Promise((e,n)=>{let r={wantBinary:!!t,resolve:e,settled:!1,baselineText:i,baselineBlob:a},o=(e,t)=>{if(r.settled)return;r.settled=!0;let n=u.indexOf(r);n!==-1&&u.splice(n,1),e(t)};r.resolve=t=>o(e,t),u.push(r),setTimeout(()=>{t&&a&&a!==r.baselineBlob?o(e,a):!t&&i&&i!==r.baselineText?o(e,i):o(n,Error(`Server clipboard request timed out with no fresh value`))},2e3)})}async function v(e){let t;try{t=await e}catch{return}if(typeof t!=`string`||!t)return;let n=document.createElement(`textarea`);n.value=t,n.setAttribute(`readonly`,``),n.style.position=`fixed`,n.style.top=`-9999px`,n.style.left=`-9999px`,n.style.opacity=`0`,document.body.appendChild(n);try{n.focus(),n.select(),n.setSelectionRange(0,n.value.length),document.execCommand(`copy`)||console.warn(`execCommand("copy") fallback returned false.`)}catch(e){console.warn(`execCommand("copy") fallback threw: ${e&&e.name} - ${e&&e.message}`)}finally{document.body.removeChild(n)}}return{sig:m,shouldSend:h,markSynced:g,localSig:_,noteLocal:ee,noteExplicit:te,forget:ne,forgetLocal:re,resolveServer:ie,captureLocalImageSig:ae,request:oe,copyViaExecCommand:v,get lastText(){return i},get lastBlob(){return a},get lastMime(){return o}}}function un({isChromium:e,clipboardSync:t,sendClipboardData:n,canSync:r,canRead:i,canWrite:a,binaryEnabled:o,getSendInFlight:s,getDeferredWriteLanding:c,hasPendingServerWrite:l,readLocalClipboard:u}){function d(){let e=document.activeElement;return!(!e||e.id===`overlayInput`||e.tagName!==`INPUT`&&e.tagName!==`TEXTAREA`&&e.tagName!==`SELECT`&&!e.isContentEditable)}let f=[],p=!1,m=null,h=-1/0,g=null;function _(){p=!1;for(let e of f.splice(0))try{let t=new KeyboardEvent(e.type,e);Object.defineProperty(t,"__selkiesClipReplay",{value:!0}),window.dispatchEvent(t)}catch{}}function ee(){for(let e=f.length-1;e>=0;e--)f[e].type===`keydown`&&f.splice(e,1);_()}let te=[`ControlLeft`,`ControlRight`,`MetaLeft`,`MetaRight`];function ne(t){if(t.__selkiesClipReplay)return;let n=p&&t.type===`keyup`&&te.includes(t.code);if(t.code!==`KeyV`&&!n)return;let a=(t.ctrlKey||t.metaKey)&&!t.altKey,o=c?c():null,l=a&&t.type===`keydown`&&!t.isComposing&&r()&&i()&&!d(),ne=!e&&l;if(e&&l&&!t.repeat&&u){let e=u().catch(()=>{});g=e,e.then(()=>{g===e&&(g=null)})}if((n||t.code===`KeyV`&&(a&&(s()||o||ne||g)||p))&&(e&&t.preventDefault(),t.stopImmediatePropagation(),f.push(t),!p)){p=!0;let e=performance.now(),t=()=>{if(ne&&h<e&&performance.now()-e<100){setTimeout(t,10);return}let n=[],r=s();r&&n.push(r),m&&n.push(m),g&&n.push(g);let i=c?c():null;if(i&&n.push(i),n.length===0){_();return}let a=1e4-(performance.now()-e);if(a<=0){ee();return}Promise.race([Promise.all(n).then(()=>`settled`,()=>`failed`),new Promise(e=>setTimeout(()=>e(`timeout`),a))]).then(e=>{e===`settled`?t():ee()})};ne?setTimeout(t,0):t()}}function re(e){if(r()&&(e.ctrlKey||e.metaKey)&&!e.altKey&&!e.repeat&&!d()&&(e.key||``).toLowerCase()===`c`&&a()){let e=t.request(!1),n={"text/plain":e.then(e=>new Blob([typeof e==`string`?e:t.lastText||``],{type:`text/plain`}))},r=null;try{r=navigator.clipboard.write([new ClipboardItem(n)])}catch(n){console.warn(`navigator.clipboard.write unavailable on Ctrl+C, using execCommand: ${n&&n.name}`),t.copyViaExecCommand(e)}r&&r.catch&&r.catch(n=>{console.warn(`navigator.clipboard.write rejected on Ctrl+C, using execCommand: ${n&&n.name} - ${n&&n.message}`),t.copyViaExecCommand(e)})}}function ie(e){if(h=performance.now(),!r()||!i()||d()||(e.preventDefault(),l&&l()))return;let a=e.clipboardData;if(!a)return;let s=null;if(o()&&a.items)for(let e=0;e<a.items.length&&!s;e++){let t=a.items[e],n=t.kind===`file`&&t.type&&t.type.startsWith(`image/`)?t.getAsFile():null;n&&(s=n.arrayBuffer().then(e=>[e,n.type||t.type]))}if(!s){let e=a.getData(`text/plain`);if(!e)return;s=Promise.resolve([e,`text/plain`])}let c=s.then(async([e,r])=>{t.noteLocal(await t.localSig(e,r))&&await n(e,r)}).catch(e=>console.warn(`Paste could not reach the session: ${e&&e.name}`));m=c,c.finally(()=>{m===c&&(m=null)})}function ae(){window.addEventListener(`keydown`,ne,!0),window.addEventListener(`keyup`,ne,!0),e||(window.addEventListener(`keydown`,re,!0),window.addEventListener(`paste`,ie,!0))}function oe(){window.removeEventListener(`keydown`,ne,!0),window.removeEventListener(`keyup`,ne,!0),e||(window.removeEventListener(`keydown`,re,!0),window.removeEventListener(`paste`,ie,!0))}return{wire:ae,unwire:oe}}function dn(){let e=``,t=``;if(typeof window>`u`||!window.location)return{keyword:e,token:t};let n=String(window.location.hash||``).replace(/^#/,``);for(let r of n.split(`&`))if(r.startsWith(`token=`)){if(!t)try{t=new URLSearchParams(r).get(`token`)||``}catch{}}else!e&&r&&(e=`#${r}`);return{keyword:e,token:t}}function fn(){return dn().keyword}var pn=`selkies_token`,mn=`selkies`,hn=`selkies.token.`;function gn(){let e=dn().token;if(e)return e;if(typeof window>`u`||!window.location)return``;try{return new URLSearchParams(window.location.search).get(`token`)||``}catch{return``}}function _n(e){let t=Object.assign({},e||{}),n=gn();return n&&!(`Authorization`in t)&&(t.Authorization=`Bearer ${n}`),t}function vn(e){let t=``;for(let n of new TextEncoder().encode(e))t+=String.fromCharCode(n);return btoa(t).replace(/\+/g,`-`).replace(/\//g,`_`).replace(/=+$/,``)}function yn(){let{token:e}=dn();return e?[mn,hn+vn(e)]:[]}function bn(){let e=gn();if(!e||typeof document>`u`)return;let t=[`path=${Ee()}/api/`,`SameSite=Strict`];window.location.protocol===`https:`&&t.push(`Secure`);try{document.cookie=`${pn}=${encodeURIComponent(e)}; ${t.join(`; `)}`}catch{}}var xn=67108864;function Sn({canUpload:e=()=>!0}={}){let t=!1;function n(e){window.postMessage({type:`fileUpload`,payload:e},window.location.origin)}function r(){return t?(console.warn(`Simultaneous uploading of files with distinct upload operations is not supported yet`),n({status:`warning`,fileName:`_N/A_`,message:`Please let the ongoing upload complete.`}),!1):(t=!0,!0)}function i(e,t,n,r,i){return new Promise((a,o)=>{let s=new XMLHttpRequest;s.open(`POST`,e,!0),s.withCredentials=!0,s.setRequestHeader(`Content-Type`,`application/octet-stream`),s.setRequestHeader(`X-Upload-Path`,encodeURIComponent(t));for(let[e,t]of Object.entries(_n(r)))s.setRequestHeader(e,t);s.upload.onprogress=i,s.onload=()=>{s.status>=200&&s.status<300?a():o(Error(`upload failed (${s.status}): ${String(s.responseText||``).slice(0,160)}`))},s.onerror=()=>{o(Error(`network error uploading ${t}`))},s.send(n)})}async function a(e,t){n({status:`start`,fileName:t,fileSize:e.size});let r=(r,i)=>n({status:r,fileName:t,fileSize:e.size,...i}),a=t=>e.size>0?Math.min(100,Math.round(t/e.size*100)):0;try{let n=new URL(`api/upload`,window.location.href).href;if(e.size<=xn)await i(n,t,e,null,t=>{let n=t.lengthComputable&&e.size>0?Math.min(100,Math.round(t.loaded/t.total*100)):0;r(`progress`,{progress:n})});else{let o=window.crypto&&crypto.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random().toString(36).slice(2)}`;for(let s=0;s<e.size;){let c=Math.min(s+xn,e.size),l={"X-Upload-Id":o,"X-Upload-Offset":String(s),"X-Upload-Total":String(e.size)};c>=e.size&&(l[`X-Upload-Final`]=`1`);let u=s;await i(n,t,e.slice(s,c),l,e=>{e.lengthComputable&&r(`progress`,{progress:a(u+e.loaded)})}),s=c,r(`progress`,{progress:a(s)})}}r(`progress`,{progress:100}),r(`end`)}catch(e){throw r(`error`,{message:e&&e.message?e.message:`error during upload of ${t}: ${e}`}),e}}function o(e){return new Promise((t,n)=>e.file(t,n))}async function s(e,t=``){let r;if(e.fullPath&&typeof e.fullPath==`string`&&e.fullPath!==e.name&&(e.fullPath.includes(`/`)||e.fullPath.includes(`\\`))?(r=e.fullPath,r.startsWith(`/`)&&(r=r.substring(1))):r=t?`${t}/${e.name}`:e.name,e.isFile)try{await a(await o(e),r)}catch(e){console.error(`Error processing file ${r}: ${e}`),n({status:`error`,fileName:r,message:`Error processing file: ${e.message||e}`})}else if(e.isDirectory){let t=e.createReader(),n;do{n=await new Promise((e,n)=>t.readEntries(e,n));for(let e of n)await s(e,r)}while(n.length>0)}}function c(){if(!e()){console.log(`File upload blocked (shared/viewer session).`);return}let t=document.getElementById(`globalFileInput`);if(!t){console.error(`Global file input not found!`);return}t.click()}async function l(i){let o=i.target.files;if(!e()||!o||o.length===0){i.target.value=null;return}if(!r()){i.target.value=null;return}console.log(`File input changed, processing ${o.length} files sequentially.`);try{for(let e=0;e<o.length;e++){let t=o[e];await a(t,t.name)}}catch(e){let t=`An error occurred during the file input upload process: ${e.message||e}`;console.error(t),n({status:`error`,fileName:`N/A`,message:t})}finally{i.target.value=null,t=!1}}function u(t){t.preventDefault(),t.dataTransfer.dropEffect=e()?`copy`:`none`}async function d(i){if(i.preventDefault(),i.stopPropagation(),!e()){console.log(`File upload via drag-drop blocked (shared/viewer session).`);return}if(r())try{let e=[];if(i.dataTransfer.items)for(let t=0;t<i.dataTransfer.items.length;t++){let n=i.dataTransfer.items[t];if(n.kind!==`file`)continue;let r=null;typeof n.webkitGetAsEntry==`function`?r=n.webkitGetAsEntry():typeof n.getAsEntry==`function`&&(r=n.getAsEntry()),r&&e.push(r)}else if(i.dataTransfer.files.length>0){for(let e=0;e<i.dataTransfer.files.length;e++)await a(i.dataTransfer.files[e],i.dataTransfer.files[e].name);return}try{for(let t of e)await s(t)}catch(e){n({status:`error`,fileName:`N/A`,message:`Error during sequential upload: ${e.message||e}`})}}finally{t=!1}}return{uploadFileObject:a,handleRequestFileUpload:c,handleFileInputChange:l,handleDragOver:u,handleDrop:d}}var Cn="const e=32768,t=5381;function n(e,t){for(let n=0;n<t.length;n++)e=(e<<5)+e+t[n]|0;return e}function r(t){let n=new TextEncoder().encode(t),r=``;for(let t=0;t<n.length;t+=e){let i=n.subarray(t,t+e);r+=String.fromCharCode.apply(null,i)}return btoa(r)}function i(e){let t=atob(e),n=t.length,r=new Uint8Array(n);for(let e=0;e<n;e++)r[e]=t.charCodeAt(e);return{text:new TextDecoder().decode(r),byteLength:n}}function a(e){let t=atob(e),n=t.length,r=new Uint8Array(n);for(let e=0;e<n;e++)r[e]=t.charCodeAt(e);return r}function o(t){let n=``;for(let r=0;r<t.length;r+=e){let i=t.subarray(r,r+e);n+=String.fromCharCode.apply(null,i)}return btoa(n)}function s(e,t){let r=e.remainder+t,i=r.length-r.length%4;if(e.remainder=r.slice(i),!i)return;let o=a(r.slice(0,i));e.parts.push(o),e.bytes+=o.length,e.hash=n(e.hash,o)}function c(e){if(e.remainder){let t=a(e.remainder);e.parts.push(t),e.bytes+=t.length,e.hash=n(e.hash,t),e.remainder=``}let t=new Uint8Array(e.bytes),r=0;for(let n of e.parts)t.set(n,r),r+=n.length;return e.parts=[],t}const l=/* @__PURE__ */ new Map;async function u(e,t){let n=null;try{n=await createImageBitmap(t);let r=new OffscreenCanvas(n.width,n.height);r.getContext(`2d`).drawImage(n,0,0);let i=await r.convertToBlob({type:`image/png`});self.postMessage({id:e,success:!0,result:i,mimeType:`image/png`,byteLength:i.size})}catch(t){self.postMessage({id:e,success:!1,error:t.message})}finally{n&&n.close()}}self.onmessage=function(e){let{id:d,action:f,payload:p,mimeType:m}=e.data;try{if(f===`DECODE_BEGIN`){l.set(d,{mimeType:m,parts:[],remainder:``,bytes:0,hash:t});return}if(f===`DECODE_CHUNK`){let e=l.get(d);e&&s(e,p);return}if(f===`DECODE_ABORT`){l.delete(d);return}if(f===`DECODE_END`){let e=l.get(d);if(l.delete(d),!e){self.postMessage({id:d,success:!1,error:`no transfer in progress`});return}let t=c(e);e.mimeType===`text/plain`?self.postMessage({id:d,success:!0,mimeType:e.mimeType,result:new TextDecoder().decode(t),byteLength:t.byteLength,hash:e.hash}):self.postMessage({id:d,success:!0,mimeType:e.mimeType,result:t.buffer,byteLength:t.byteLength,hash:e.hash},[t.buffer]);return}if(f===`HASH_BYTES`){let e=new Uint8Array(p);self.postMessage({id:d,success:!0,byteLength:e.byteLength,hash:n(t,e)});return}if(f===`REENCODE_PNG`){u(d,p);return}if(f===`ENCODE_BINARY_TO_B64`){let r=new Uint8Array(p),i=o(r);self.postMessage({id:d,success:!0,result:i,byteLength:r.byteLength,hash:n(e.data.hash===void 0?t:e.data.hash,r)})}else if(f===`ENCODE_TEXT_TO_B64`){let e=r(p);self.postMessage({id:d,success:!0,result:e})}else if(f===`DECODE_FROM_B64`){if(m===`text/plain`){let{text:e,byteLength:t}=i(p);self.postMessage({id:d,success:!0,result:e,mimeType:m,byteLength:t})}else{let e=a(p);self.postMessage({id:d,success:!0,result:e.buffer,mimeType:m,byteLength:e.byteLength,hash:n(t,e)},[e.buffer])}}else self.postMessage({id:d,success:!1,error:`Unknown action: ${f}`})}catch(e){self.postMessage({id:d,success:!1,error:e.message})}};",wn=typeof self<`u`&&self.Blob&&new Blob([`URL.revokeObjectURL(import.meta.url);`,Cn],{type:`text/javascript;charset=utf-8`});function Tn(e){let t;try{if(t=wn&&(self.URL||self.webkitURL).createObjectURL(wn),!t)throw``;let n=new Worker(t,{type:`module`,name:e?.name});return n.addEventListener(`error`,()=>{(self.URL||self.webkitURL).revokeObjectURL(t)}),n}catch{return new Worker(`data:text/javascript;charset=utf-8,`+encodeURIComponent(Cn),{type:`module`,name:e?.name})}}var En=class{constructor(){this.worker=null,this.callbacks=new Map,this.msgId=0}init(){this.worker||(this.worker=new Tn,this.worker.onmessage=e=>{let{id:t,success:n,result:r,error:i,mimeType:a,byteLength:o,hash:s}=e.data,c=this.callbacks.get(t);c&&(this.callbacks.delete(t),n?c.resolve({result:r,mimeType:a,byteLength:o,hash:s}):c.reject(Error(i)))},console.log(`Clipboard Web Worker initialized.`))}terminate(){if(!this.worker)return;this.worker.terminate(),this.worker=null;let e=Array.from(this.callbacks.values());this.callbacks.clear();for(let{reject:t}of e){let e=Error(`Worker Terminated`);e.name=`AbortError`,t(e)}console.log(`Clipboard Web Worker terminated and pending operations aborted.`)}async encodeText(e){return this.init(),new Promise((t,n)=>{let r=++this.msgId;this.callbacks.set(r,{resolve:t,reject:n}),this.worker.postMessage({id:r,action:`ENCODE_TEXT_TO_B64`,payload:e})})}async encodeBinary(e,t){return this.init(),new Promise((n,r)=>{let i=++this.msgId;this.callbacks.set(i,{resolve:n,reject:r}),this.worker.postMessage({id:i,action:`ENCODE_BINARY_TO_B64`,payload:e,hash:t},[e])})}async hashBytes(e){return this.init(),new Promise((t,n)=>{let r=++this.msgId;this.callbacks.set(r,{resolve:t,reject:n}),this.worker.postMessage({id:r,action:`HASH_BYTES`,payload:e},[e])})}async reencodePng(e){return this.init(),new Promise((t,n)=>{let r=++this.msgId;this.callbacks.set(r,{resolve:t,reject:n}),this.worker.postMessage({id:r,action:`REENCODE_PNG`,payload:e})})}async decode(e,t){return this.init(),new Promise((n,r)=>{let i=++this.msgId;this.callbacks.set(i,{resolve:n,reject:r}),this.worker.postMessage({id:i,action:`DECODE_FROM_B64`,payload:e,mimeType:t})})}decodeStream(e){this.init();let t=++this.msgId;return this.worker.postMessage({id:t,action:`DECODE_BEGIN`,mimeType:e}),{push:e=>{this.worker&&this.worker.postMessage({id:t,action:`DECODE_CHUNK`,payload:e})},finish:()=>new Promise((e,n)=>{if(!this.worker){n(Error(`Worker Terminated`));return}this.callbacks.set(t,{resolve:e,reject:n}),this.worker.postMessage({id:t,action:`DECODE_END`})}),abort:()=>{this.worker&&this.worker.postMessage({id:t,action:`DECODE_ABORT`})}}}},Dn=5381;async function On(e,t,n){try{let r=t.slice(),i=await e.encodeBinary(r.buffer,n);return{b64:i.result,hash:i.hash}}catch(e){console.warn(`Clipboard worker encode failed; falling back to main thread:`,e);let n=``;for(let e=0;e<t.length;e+=32768)n+=String.fromCharCode.apply(null,t.subarray(e,e+32768));return{b64:btoa(n),hash:void 0}}}async function kn(e,t,{worker:n,send:r,waitDrain:i,chunkRawBytes:a,nextTid:o}){let s=t===`text/plain`,c=e.byteLength;if(c<a){let{b64:i,hash:a}=await On(n,e,Dn);return r(s?`cw,${i}`:`cb,${t},${i}`),a}let l=o();r(s?`cws,${l},${c}`:`cbs,${l},${t},${c}`);let u=Dn;for(let t=0;t<c;t+=a){if(i&&await i()===!1)return;let o=await On(n,e.subarray(t,t+a),u);u=o.hash,r(s?`cwd,${l},${o.b64}`:`cbd,${l},${o.b64}`)}return r(s?`cwe,${l}`:`cbe,${l}`),u}var An={de:`de`,fr:`fr`,es:`es`,it:`it`,pt:`pt`,ru:`ru`,pl:`pl`,cs:`cz`,sk:`sk`,hu:`hu`,tr:`tr`,da:`dk`,sv:`se`,nb:`no`,nn:`no`,no:`no`,fi:`fi`,nl:`nl`,ja:`jp`,ko:`kr`,el:`gr`,he:`il`,uk:`ua`,en:`us`},jn={GB:`gb`,BR:`br`,CH:`ch`,BE:`be`};function Mn(e){if(!e||typeof e!=`string`)return null;let[t,n]=e.split(`-`);if(n){let e=jn[n.toUpperCase()];if(e)return e}return An[t.toLowerCase()]||null}async function Nn(){try{let e=navigator.keyboard;if(e&&typeof e.getLayoutMap==`function`){let t=await e.getLayoutMap();if(t&&t.size){let e=e=>(t.get(e)||``).toLowerCase();if(e(`KeyY`)===`z`&&e(`KeyZ`)===`y`)return e(`Minus`)===`ß`?`de`:Mn(navigator.language)||`de`;if(e(`KeyQ`)===`a`&&e(`KeyA`)===`q`)return`fr`;if(e(`Semicolon`)===`ñ`)return`es`;if(e(`Semicolon`)===`ò`)return`it`;if(e(`KeyY`)===`y`&&e(`KeyQ`)===`q`){if(e(`Backslash`)===`#`)return`gb`;if(e(`Semicolon`)===`;`)return`us`}}}}catch{}return Mn(navigator.language)}var Pn=!1;function Fn(){if(Pn||typeof window>`u`)return;Pn=!0;let e=window.fetch.bind(window),t=`__selkiesAuthReloadChain`,n=()=>{try{let e=JSON.parse(sessionStorage.getItem(t)||`null`);if(e)return e}catch{}try{let e=window.history.state;if(e&&typeof e==`object`&&e[t])return e[t]}catch{}return null},r=e=>{let n=!1;try{sessionStorage.setItem(t,JSON.stringify(e)),n=!0}catch{}if(!n)try{let n=window.history.state;(n==null||typeof n==`object`&&!Array.isArray(n))&&window.history.replaceState(Object.assign({},n||{},{[t]:e}),``)}catch{}},i=0,a=n();a&&Date.now()-a.at<3e4&&(i=a.n|0);let o=!1,s=!1,c=()=>{if(o||i>=2){!o&&!s&&(s=!0,console.warn(`auth-guard: 401 persists after reloads; leaving the page as-is instead of looping.`));return}o=!0,r({at:Date.now(),n:i+1}),window.location.reload()},l=e=>{try{let t=typeof e==`string`||e instanceof URL?String(e):e.url;return new URL(t,window.location.href).origin===window.location.origin}catch{return!0}},u=e=>{try{return/^Bearer realm="Selkies/i.test(e.headers.get(`WWW-Authenticate`)||``)}catch{return!1}};window.__selkiesAuthReload=c,window.fetch=async(...t)=>{let n=await e(...t);return n.status===401&&l(t[0])&&!u(n)&&c(),n},window.__selkiesAuthProbe=()=>{try{window.fetch(new Request(window.location.href,{method:`HEAD`,cache:`no-store`,credentials:`same-origin`})).catch(()=>{})}catch{}}}function In(e,t,n,r){if(e===`jpeg`||!t)return null;let a=t[i(e)];if(!a||!a.ten_bit)return null;let o=e=>{let t=a.ten_bit[e],n=!!(r&&a.fullcolor&&a.fullcolor[e]);return t&&t[n?`444`:`420`]?{fullcolor:n,software:e===`software`}:null};return n||e===`h264enc-striped`||!a.hardware||r&&a.fullcolor&&a.fullcolor.hardware===!1&&a.fullcolor.software?o(`software`):o(`hardware`)||o(`software`)}function Ln({server:e,stored:t,parse:n=e=>e,conditional:r,isValid:i}){let a=e=>e!=null&&(!i||i(e));if(e&&e.locked)return e.value;if(t!=null){let e=n(t);if(a(e))return e}if(e&&e.overridden&&a(e.value))return e.value;let o=r?r():void 0;return a(o)?o:e?e.value:void 0}function Rn(e,t,n,r){let i=Ln({server:t?t[e.serverKey]:void 0,stored:r(e.storageKey),parse:e.parse,conditional:e.conditional?()=>e.conditional(n):void 0,isValid:e.isValid?t=>e.isValid(t,n):void 0})??e.fallback;return e.toUi?e.toUi(i):i}var zn={id:`hidpi`,serverKey:`use_css_scaling`,storageKey:`useCssScaling`,parse:e=>e===`true`,conditional:e=>e.manualActive?!0:void 0,fallback:!1,toUi:e=>!e,toServer:e=>!e,serialize:e=>String(!e),propagate:(e,t,n)=>n.postToCore({type:`setUseCssScaling`,value:e})},Bn={id:`rate_control_mode`,serverKey:`rate_control_mode`,storageKey:`rate_control_mode`,isValid:(e,t)=>t.allowedRateControl.includes(e),fallback:`cbr`,propagate:(e,t,n)=>n.postSetting({rate_control_mode:e})};function Vn(e,t,n){return{id:e,serverKey:e,storageKey:e,parse:e=>e===`true`,fallback:t,propagate:n}}var Hn=Vn(`use_browser_cursors`,!1,(e,t,n)=>n.postToCore({type:`setUseBrowserCursors`,value:e})),Un=Vn(`video_fullcolor`,!1,(e,t,n)=>n.postSetting({video_fullcolor:e})),Wn=Vn(`video_10bit`,!1,(e,t,n)=>n.postSetting({video_10bit:e})),Gn=Vn(`video_streaming_mode`,!1,(e,t,n)=>n.postSetting({video_streaming_mode:e})),Kn={...Vn(`use_paint_over_quality`,!0,(e,t,n)=>n.postSetting({use_paint_over_quality:e})),conditional:e=>e.videoStreamingMode===void 0?void 0:e.encoder===`jpeg`||!e.videoStreamingMode},qn=Vn(`use_cpu`,!1,(e,t,n)=>n.postSetting({use_cpu:e})),Jn=Vn(`cpu_encode_threading`,!0,(e,t,n)=>n.postSetting({cpu_encode_threading:e})),Yn=Vn(`force_aligned_resolution`,!1,(e,t,n)=>n.postSetting({force_aligned_resolution:e})),Xn={...Vn(`raw_pointer_motion`,!0,(e,t,n)=>n.postToCore({type:`setRawPointerMotion`,value:e})),conditional:e=>!e.macDesktop&&void 0},Zn=Vn(`mac_cmd_as_ctrl`,!0,(e,t,n)=>n.postToCore({type:`setMacCmdAsCtrl`,value:e})),Qn=[zn,Bn,Hn,Un,Wn,Gn,Kn,qn,Jn,Yn,Xn,Zn].reduce((e,t)=>(t.storageKey!==t.serverKey&&(e[t.serverKey]=t.storageKey),e),{});function $n(e){return Qn[e]||e}var er=[{id:1,name:`h264`,codec:`avc1.42E01F`,extra:{avc:{format:`annexb`}}},{id:2,name:`vp8`,codec:`vp8`,extra:{}},{id:3,name:`vp9`,codec:`vp09.00.31.08`,extra:{}},{id:4,name:`av1`,codec:`av01.0.05M.08`,extra:{}},{id:5,name:`h265`,codec:`hev1.1.6.L93.B0`,extra:{hevc:{format:`annexb`}}}],tr=4e3,nr=2,rr=[`auto`,`h264`,`h265`,`vp8`,`vp9`,`av1`,`mjpeg`],ir=1/6;function ar(){let e=0,t=0;return{note(n){e++,n&&t++},tooSlow(){if(e<60)return!1;let n=t/e>ir;return e=0,t=0,n},behindRatio(){return e?t/e:0},reset(){e=0,t=0}}}function or(e){let t=15e3/(e>0?e:30),n=[];return{budgetMs:t,sent(e,t){n.push({timestamp:e,wall:t})},answered(e){for(;n.length&&n[0].timestamp<=e;)n.shift()},lagMs(e){return n.length?e-n[0].wall:0},reset(){n=[]}}}var sr=e=>{e&&typeof e.close==`function`&&e.close()},cr=2,lr=typeof VideoFrame<`u`&&typeof VideoFrame.prototype==`object`&&`rotation`in VideoFrame.prototype,ur=-90,dr={rotation:0,flip:!1},fr=()=>((window.orientation-ur)%360+360)%360,W=()=>!lr&&typeof window.orientation==`number`,pr=`
let reader = null, track = null, inFlight = 0;
self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'ack') { if (inFlight > 0) inFlight--; return; }
  if (m.type === 'stop') { try { reader && reader.cancel(); } catch (err) {} try { track && track.stop(); } catch (err) {} reader = null; return; }
  if (m.type !== 'source') return;
  track = m.track;
  try { reader = new MediaStreamTrackProcessor({ track }).readable.getReader(); }
  catch (err) { self.postMessage({ type: 'failed' }); return; }
  self.postMessage({ type: 'ready' });
  for (;;) {
    let r;
    try { r = await reader.read(); } catch (err) { break; }
    if (r.done) break;
    if (inFlight >= ${cr}) { r.value.close(); continue; }
    inFlight++;
    self.postMessage({ type: 'frame', frame: r.value }, [r.value]);
  }
  self.postMessage({ type: 'end' });
};
`,G=`
let CANDIDATES = ${JSON.stringify(er)};
const PACE_MIN_SAMPLES = 60;
const PACE_BEHIND_RATIO = ${ir};
const PACE_LAG_INTERVALS = 15;
const PROBE_COLOR_TOLERANCE = 48;
const createLagGauge = ${or.toString()};
const KEYFRAME_INTERVAL_MS = ${tr};
const HAS_FRAME_ORIENTATION = ${lr};
// Frames taken from the camera to measure the candidates with, how long to wait
// for them, and the time one candidate may spend on them. Synthetic content
// cannot stand in: a codec costs what the lens shows, at the size it shows it.
const PROBE_SOURCE_FRAMES = 8;
const PROBE_WAIT_MS = 2500;
const PROBE_BUDGET_MS = 400;
// Share of the asked rate a candidate must clearly reach to start on: a few
// frames either way is noise, and the watchdog judges what the camera then
// does to it on real frames.
const PROBE_RATE_MARGIN = 0.9;
let encoder = null, candIndex = 0, cand = null, configuring = false, active = true;
let wirePort = null;
// Camera frames held while probing; during the measurement itself further
// frames are dropped, so nothing reaches the wire unvetted.
let probing = false, measuring = false, probeFrames = [], probeTimer = null;
let fps = 30, bitrate = 2500000, encodedSize = null, forceKeyframe = true, lastKeyframeMs = 0;
let trackReader = null, trackRef = null;
// The pace window (see createEncodePace) and the staleness gauge that
// catches an encoder holding frames off-queue.
let paceOffered = 0, paceBehind = 0, lag = null;
// The upright transform every chunk is stamped with, and the one the encoder
// latched: they differ where the page derives what the frames do not carry, and
// then no rebuild is owed for a turn the encoder never sees.
let orientation = { rotation: 0, flip: false }, derived = null;

function encoderConfig(c, w, h) {
  return { codec: c.codec, width: w, height: h, bitrate, framerate: fps, latencyMode: 'realtime', ...c.extra };
}

async function makeEncoder(w, h, latched) {
  configuring = true;
  while (candIndex < CANDIDATES.length) {
    cand = CANDIDATES[candIndex];
    let support = null;
    try { support = await VideoEncoder.isConfigSupported(encoderConfig(cand, w, h)); } catch (err) { support = null; }
    if (!active) { configuring = false; return false; }
    if (!support || !support.supported) { candIndex++; continue; }
    try {
      const enc = new VideoEncoder({
        output: (chunk) => {
          if (lag) lag.answered(chunk.timestamp);
          if (!active) return;
          const buf = new ArrayBuffer(chunk.byteLength);
          chunk.copyTo(new Uint8Array(buf));
          const framed = { codecId: cand.id, keyframe: chunk.type === 'key', buffer: buf,
                           rotation: orientation.rotation, flip: orientation.flip };
          if (wirePort) wirePort.postMessage(framed, [buf]);
          else self.postMessage({ type: 'chunk', ...framed }, [buf]);
        },
        error: (err) => { try { encoder && encoder.close(); } catch (x) {} encoder = null; encodedSize = null; lag = null; candIndex++; },
      });
      enc.configure(support.config || encoderConfig(cand, w, h));
      encoder = enc; encodedSize = { w: w, h: h, rotation: latched.rotation, flip: latched.flip };
      lag = createLagGauge(fps);
      forceKeyframe = true; configuring = false;
      self.postMessage({ type: 'ready', codec: cand.name });
      return true;
    } catch (err) { candIndex++; }
  }
  encoder = null; encodedSize = null; configuring = false;
  self.postMessage({ type: 'unsupported' });
  return false;
}

function encodeWith(frame, w, h) {
  if (!encoder || encoder.state !== 'configured' || !active) { frame.close(); return; }
  const now = performance.now();
  // A visible queue and stale output both count as behind.
  const behind = encoder.encodeQueueSize > 1 || (lag !== null && lag.lagMs(now) > lag.budgetMs);
  paceOffered++;
  if (behind) paceBehind++;
  if (paceOffered >= PACE_MIN_SAMPLES) {
    const slow = paceBehind / paceOffered > PACE_BEHIND_RATIO;
    paceOffered = 0; paceBehind = 0;
    // Dropping or delaying this much of the camera is what a codec this
    // engine cannot encode in real time looks like: a core at full tilt and
    // a receiver falling behind. Take the next rung; the page takes the JPEG
    // one when this list runs out.
    if (slow) {
      self.postMessage({ type: 'slow', codec: cand ? cand.name : '' });
      try { if (encoder && encoder.state !== 'closed') encoder.close(); } catch (err) {}
      encoder = null; encodedSize = null; lag = null; candIndex++;
      if (candIndex >= CANDIDATES.length) self.postMessage({ type: 'exhausted' });
      frame.close();
      return;
    }
  }
  // The encoder is behind: drop this input frame (never an encoded output) so no
  // reference chain breaks; a worker rarely reaches this, which is the point.
  if (behind) { frame.close(); return; }
  const keyFrame = forceKeyframe || now - lastKeyframeMs >= KEYFRAME_INTERVAL_MS;
  try {
    encoder.encode(frame, { keyFrame: keyFrame });
    if (lag) lag.sent(frame.timestamp, now);
    if (keyFrame) { lastKeyframeMs = now; forceKeyframe = false; }
  } catch (err) { try { encoder.close(); } catch (x) {} encoder = null; encodedSize = null; lag = null; candIndex++; }
  frame.close();
}

function orientationOf(frame) {
  return HAS_FRAME_ORIENTATION
    ? { rotation: frame.rotation || 0, flip: !!frame.flip }
    : { rotation: 0, flip: false };
}

function handleFrame(frame, label) {
  if (!active) { frame.close(); return; }
  const w = frame.displayWidth || frame.codedWidth;
  const h = frame.displayHeight || frame.codedHeight;
  const latched = orientationOf(frame);
  orientation = label || (HAS_FRAME_ORIENTATION ? latched : (derived || orientation));
  if (probing) {
    if (measuring || probeFrames.length >= PROBE_SOURCE_FRAMES) { frame.close(); return; }
    // The window belongs to the camera once it is delivering. A device chosen
    // from several starts late, and a window spent waiting for it would expire
    // holding too few frames to measure anything.
    if (!probeFrames.length && probeTimer !== null) {
      clearTimeout(probeTimer);
      probeTimer = setTimeout(() => { if (probing) runProbe(w, h); }, PROBE_WAIT_MS);
    }
    probeFrames.push(frame);
    if (probeFrames.length >= PROBE_SOURCE_FRAMES) runProbe(w, h);
    return;
  }
  if (configuring) { frame.close(); return; }
  // A spent ladder was announced once; later frames are not a fresh verdict.
  if (!encoder && candIndex >= CANDIDATES.length) { frame.close(); return; }
  if (!encoder || !encodedSize || encodedSize.w !== w || encodedSize.h !== h ||
      encodedSize.rotation !== latched.rotation || encodedSize.flip !== latched.flip) {
    makeEncoder(w, h, latched).then(() => { if (encoder) encodeWith(frame, w, h); else frame.close(); });
    return;
  }
  encodeWith(frame, w, h);
}

// Frames per second one candidate sustains on the camera's own frames, or 0 if
// it cannot encode them.
async function measure(c, w, h, frames) {
  const out = { rate: 0, colErr: -1 };
  let support = null;
  try { support = await VideoEncoder.isConfigSupported(encoderConfig(c, w, h)); } catch (err) { return out; }
  if (!support || !support.supported) return out;
  let encoded = 0, failed = false;
  const chunks = [];
  const enc = new VideoEncoder({
    output: (chunk) => {
      encoded++;
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({ key: chunk.type === 'key', ts: chunk.timestamp, data });
    },
    error: () => { failed = true; },
  });
  try { enc.configure(support.config || encoderConfig(c, w, h)); } catch (err) { return out; }
  const started = performance.now();
  // The frames stay open: each candidate encodes the same ones, and the probe
  // closes them once the last candidate has had its turn.
  for (let i = 0; i < frames.length && !failed; i++) {
    try { enc.encode(frames[i], { keyFrame: i === 0 }); } catch (err) { failed = true; }
  }
  await Promise.race([
    enc.flush().catch(() => { failed = true; }),
    new Promise((r) => setTimeout(r, PROBE_BUDGET_MS)),
  ]);
  const rate = encoded / ((performance.now() - started) / 1000);
  try { enc.close(); } catch (err) { /* already closed */ }
  if (failed) return out;
  out.rate = rate;
  out.colErr = await colorError(frames[0], chunks, c);
  return out;
}

// Largest per-channel difference between region means of the first probe frame
// and its own decoded output, or -1 when there is nothing to judge with (an
// unjudged candidate passes). Drawn unscaled over a coarse grid: means converge
// however lossily grain encodes while false chroma moves whole regions, and
// drawImage downscaling point-samples on some engines.
async function colorError(frame, chunks, c) {
  if (typeof OffscreenCanvas === 'undefined' || typeof VideoDecoder === 'undefined' || !chunks.length) return -1;
  const cells = 4;
  const regionMeans = (source, w, h) => {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(source, 0, 0);
    const d = ctx.getImageData(0, 0, w, h).data;
    const sums = new Float64Array(cells * cells * 3);
    const counts = new Float64Array(cells * cells);
    for (let y = 0; y < h; y++) {
      const rowCell = (((y * cells) / h) | 0) * cells;
      for (let x = 0; x < w; x++) {
        const cell = rowCell + (((x * cells) / w) | 0);
        const i = (y * w + x) * 4;
        sums[cell * 3] += d[i];
        sums[cell * 3 + 1] += d[i + 1];
        sums[cell * 3 + 2] += d[i + 2];
        counts[cell]++;
      }
    }
    for (let cell = 0; cell < counts.length; cell++) {
      sums[cell * 3] /= counts[cell];
      sums[cell * 3 + 1] /= counts[cell];
      sums[cell * 3 + 2] /= counts[cell];
    }
    return sums;
  };
  const decoded = [];
  try {
    const w = frame.displayWidth || frame.codedWidth;
    const h = frame.displayHeight || frame.codedHeight;
    const want = regionMeans(frame, w, h);
    let failed = false;
    const dec = new VideoDecoder({ output: (f) => decoded.push(f), error: () => { failed = true; } });
    dec.configure({ codec: c.codec });
    for (let i = 0; i < chunks.length; i++) {
      dec.decode(new EncodedVideoChunk({ type: chunks[i].key ? 'key' : 'delta', timestamp: chunks[i].ts, data: chunks[i].data }));
    }
    await dec.flush();
    let err = -1;
    if (decoded.length && !failed) {
      const got = regionMeans(decoded[decoded.length - 1], w, h);
      err = 0;
      for (let i = 0; i < want.length; i++) err = Math.max(err, Math.abs(want[i] - got[i]));
    }
    try { dec.close(); } catch (e2) { /* already closed */ }
    for (let i = 0; i < decoded.length; i++) { try { decoded[i].close(); } catch (e2) {} }
    return err;
  } catch (err) {
    for (let i = 0; i < decoded.length; i++) { try { decoded[i].close(); } catch (e2) {} }
    return -1;
  }
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'frame') { handleFrame(m.frame, { rotation: m.rotation, flip: m.flip }); return; }
  // The page derives what a track this worker reads cannot tell it: no window here.
  if (m.type === 'orientation') { derived = { rotation: m.rotation, flip: m.flip }; return; }
  if (m.type === 'track') {
    // Combined read+encode: read the transferred camera track in this worker, so
    // frames never reach the page thread. Needs a worker MediaStreamTrackProcessor.
    if (typeof MediaStreamTrackProcessor === 'undefined') { self.postMessage({ type: 'track_unsupported' }); return; }
    try { trackReader = new MediaStreamTrackProcessor({ track: m.track }).readable.getReader(); }
    catch (err) { self.postMessage({ type: 'track_unsupported' }); return; }
    trackRef = m.track;
    self.postMessage({ type: 'track_reading' });
    (async () => {
      for (;;) {
        let r;
        try { r = await trackReader.read(); } catch (err) { break; }
        if (r.done || !active) { if (r.value) r.value.close(); break; }
        handleFrame(r.value);
      }
    })();
    return;
  }
  if (m.type === 'keyframe') { forceKeyframe = true; return; }
  if (m.type === 'wirePort') {
    // Encoded frames then go straight to the transport; the receiver answers
    // {needKeyframe:true} when a send gap broke the delta chain.
    wirePort = m.port;
    wirePort.onmessage = (ev) => { if (ev.data && ev.data.needKeyframe) forceKeyframe = true; };
    return;
  }
  if (m.type === 'config') { if (m.fps) fps = m.fps; if (m.bitrate) bitrate = m.bitrate; return; }
  if (m.type === 'stop') {
    active = false;
    try { trackReader && trackReader.cancel(); } catch (x) {}
    try { trackRef && trackRef.stop(); } catch (x) {}
    trackReader = null; trackRef = null;
    try { encoder && encoder.close(); } catch (x) {} encoder = null;
    return;
  }
  if (m.type === 'probe') {
    fps = m.fps || 30; bitrate = m.bitrate || 2500000;
    if (Array.isArray(m.candidates) && m.candidates.length) CANDIDATES = m.candidates;
    if (typeof VideoEncoder === 'undefined') { self.postMessage({ type: 'unsupported' }); return; }
    probing = true; probeFrames = [];
    // A camera that never delivers must not hold the uplink: rank on whatever
    // arrived, and if nothing did, open on the first candidate and leave the
    // watchdog to answer for it.
    probeTimer = setTimeout(() => {
      if (probing) runProbe(m.width || 1280, m.height || 720);
    }, PROBE_WAIT_MS);
  }
};

// Ranks the candidates on the held camera frames and commits to one, or hands
// the page the JPEG rung when none of them keeps up with what the lens is
// showing at the size it is showing it.
async function runProbe(w, h) {
  if (!probing || measuring) return;
  measuring = true;
  if (probeTimer !== null) { clearTimeout(probeTimer); probeTimer = null; }
  const frames = probeFrames;
  probeFrames = [];
  // A partial set is no measurement: a few frames carry the keyframe and the
  // flush and read low enough to reject a codec that keeps up, so open on
  // the first candidate and let the watchdog answer for it.
  if (frames.length < PROBE_SOURCE_FRAMES) {
    probing = false; measuring = false;
    for (let i = 0; i < frames.length; i++) { try { frames[i].close(); } catch (err) {} }
    if (!active) return;
    self.postMessage({ type: 'probed', codec: CANDIDATES[0].name });
    return;
  }
  let best = -1, bestRate = 0, wrongColor = false;
  for (let i = 0; i < CANDIDATES.length; i++) {
    const m = await measure(CANDIDATES[i], w, h, frames);
    // Wrong colors are out however fast; the JPEG rung draws through the
    // reference's own path.
    if (m.colErr > PROBE_COLOR_TOLERANCE) {
      wrongColor = true;
      self.postMessage({ type: 'wrongcolor', codec: CANDIDATES[i].name, colErr: Math.round(m.colErr) });
      continue;
    }
    if (m.rate > bestRate) { best = i; bestRate = m.rate; }
    if (m.rate >= fps) break;
  }
  probing = false; measuring = false;
  for (let i = 0; i < frames.length; i++) { try { frames[i].close(); } catch (err) {} }
  if (!active) return;
  if (best < 0) {
    candIndex = CANDIDATES.length;
    self.postMessage({ type: wrongColor ? 'exhausted' : 'unsupported' });
    return;
  }
  // Nothing near the asked rate: starting anyway spends a core to send a
  // fraction of the camera, which the JPEG rung exists to avoid. Merely-near
  // is taken; the watchdog answers for it.
  if (bestRate < fps * PROBE_RATE_MARGIN) {
    candIndex = CANDIDATES.length;
    self.postMessage({ type: 'exhausted', codec: CANDIDATES[best].name, rate: bestRate.toFixed(1) });
    return;
  }
  candIndex = best;
  self.postMessage({ type: 'probed', codec: CANDIDATES[best].name, rate: Math.round(bestRate) });
}
`,mr=class{constructor(e){this._sendFrame=e.sendFrame,this._onStateChange=e.onStateChange||(()=>{}),this._onError=e.onError||(()=>{}),this._canSend=e.canSend||(()=>!0),this.width=e.width||1280,this.height=e.height||720,this.fps=e.fps||30,this.bitrate=e.bitrate||25e5,this.quality=e.quality||.8,this.encoderPreference=rr.indexOf(e.encoderPreference)>=0?e.encoderPreference:`auto`,this._encoderCandidates=er.some(e=>e.name===this.encoderPreference)?er.filter(e=>e.name===this.encoderPreference):er,this._stream=null,this._track=null,this._source=null,this._establishing=!1,this._encoder=null,this._encoderCodec=null,this._candidateIndex=0,this._encodedSize=null,this._forceKeyframe=!0,this._chainBroken=!1,this._lastKeyframeMs=0,this._lastFrameMs=0,this._frameCredit=0,this._canvas=null,this._ctx=null,this._jpegBusy=!1,this._pace=ar(),this._configuring=!1,this._deriveOrientation=!1,this._orientation=dr,this._orientationWatch=null,this._active=!1,this._generation=0,this._encodeWorker=null,this._wireProvider=null,this._workerTrackUnsupported=!1,this._settleEncodeWorker=null,this._workerIsSource=!1,this._encoderCodecName=null}get active(){return this._active}get codec(){return this._encoderCodecName?this._encoderCodecName:this._encoderCodec?this._encoderCodec.name:this._active?`mjpeg`:null}_logPath(e){this._loggedPaths||=new Set,!this._loggedPaths.has(e)&&(this._loggedPaths.add(e),console.info(`[Webcam] ${e}`))}async start(e){if(this._active)return;if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){let e=Error(`getUserMedia unavailable`);e.name=`NotSupportedError`,this._onError(e);return}let t={width:{ideal:this.width},height:{ideal:this.height},frameRate:{ideal:this.fps}};e&&(t.deviceId={exact:e});let n=++this._generation,r;try{r=await navigator.mediaDevices.getUserMedia({video:t,audio:!1})}catch(e){this._generation===n&&this._onError(e);return}if(this._generation!==n){r.getTracks().forEach(e=>e.stop());return}let i=r.getVideoTracks()[0];if(!i){r.getTracks().forEach(e=>e.stop()),this._onError(Error(`no video track`));return}this._stream=r,this._track=i,this._active=!0,this._forceKeyframe=!0,this._chainBroken=!1,this._lastFrameMs=0,this._frameCredit=0;let a=++this._generation;if(i.addEventListener(`ended`,()=>{this._generation===a&&this.stop()}),this._onStateChange(!0),this._source=await this._openCapture(i,a),this._generation!==a){this._source&&this._source.close();return}this._source||(this._onError(Error(`no frame source for the camera track`)),this.stop())}requestKeyframe(){if(this._forceKeyframe=!0,this._encodeWorker)try{this._encodeWorker.postMessage({type:`keyframe`})}catch{}}stop(){if(this._generation++,this._active||this._stream){if(this._active=!1,this._stopEncodeWorker(),this._source&&=(this._source.close(),null),this._encoder){try{this._encoder.close()}catch{}this._encoder=null,this._encoderCodec=null}this._configuring=!1,this._deriveOrientation=!1,this._orientation=dr,this._unwatchOrientation(),this._stream&&(this._stream.getTracks().forEach(e=>{try{e.stop()}catch{}}),this._stream=null,this._track=null),this._canvas=null,this._ctx=null,this._encodedSize=null,this._candidateIndex=0,this._encoderCodecName=null,this._chainBroken=!1,this._lastFrameMs=0,this._frameCredit=0,this._onStateChange(!1)}}async _openCapture(e,t){this._establishing=!0,this.encoderPreference===`mjpeg`&&(this._candidateIndex=this._encoderCandidates.length,this._encoderCodecName=`mjpeg`,this._logPath(`encode: JPEG (webcam_encoder is mjpeg)`));let n=this._openEncodeWorker(t);try{let r=null,i=!1;return this._encodeWorker&&(r=await this._tryCombinedWorker(e,t),i=!!r,this._generation!==t)||(r||=await this._openSource(e,t),this._generation!==t)||(await n,this._generation!==t)||i&&!this._encodeWorker&&(r=await this._openSource(e,t),this._generation!==t)?(r&&r.close(),null):r}finally{this._establishing=!1}}_tryCombinedWorker(e,t){let n=this._encodeWorker;if(!n)return Promise.resolve(null);let r;try{r=e.clone()}catch{return Promise.resolve(null)}return new Promise(e=>{let i=!1,a=t=>{i||(i=!0,n.removeEventListener(`message`,o),clearTimeout(s),e(t))},o=e=>{let i=e.data;if(i.type===`track_reading`)this._generation===t&&(this._workerIsSource=!0,this._deriveOrientation=W(),this._watchOrientation(),this._logPath(`capture+encode: camera read and encoded in a worker`)),a({close:()=>{this._encodeWorker===n&&this._stopEncodeWorker()}});else if(i.type===`track_unsupported`){this._workerTrackUnsupported=!0;try{r.stop()}catch{}a(null)}},s=setTimeout(()=>{try{r.stop()}catch{}a(null)},2e3);n.addEventListener(`message`,o);try{n.postMessage({type:`track`,track:r},[r])}catch{try{r.stop()}catch{}a(null)}})}setWireProvider(e){this._wireProvider=e}_openEncodeWorker(e){if(typeof VideoEncoder>`u`||typeof Worker>`u`||this._candidateIndex>=this._encoderCandidates.length)return Promise.resolve();let t;try{let e=URL.createObjectURL(new Blob([G],{type:`text/javascript`}));t=new Worker(e),URL.revokeObjectURL(e)}catch{return Promise.resolve()}return new Promise(n=>{let r=!1,i=()=>{r||(r=!0,this._settleEncodeWorker===a&&(this._settleEncodeWorker=null),n())},a=()=>{clearTimeout(s),i()},o=n=>{console.warn(`[Webcam] encode-worker unavailable, encoding on the page:`,n);let r=this._workerIsSource;this._encodeWorker===t&&(this._encodeWorker=null),this._workerIsSource=!1;try{t.terminate()}catch{}i(),r&&!this._establishing&&this._active&&this._generation===e&&(this._source=null,this._openSource(this._track,e).then(t=>{if(this._generation!==e){t&&t.close();return}this._source=t,t||this._onError(Error(`no frame source for the camera track`))}))},s=setTimeout(()=>o(`probe timeout`),8e3);t.onmessage=n=>{let r=n.data;if(r.type===`probed`){if(clearTimeout(s),this._encodeWorker=t,this._wireProvider)try{let e=this._wireProvider();e&&t.postMessage({type:`wirePort`,port:e},[e])}catch{}this._encoderCodecName=r.codec,this._logPath(r.rate===void 0?`encode: ${r.codec} in a worker, unmeasured (no camera frames to rank on)`:`encode: ${r.codec} in a worker, ${r.rate} fps measured against ${this.fps} asked for`),i();return}if(r.type===`ready`){this._encoderCodecName=r.codec;return}if(r.type===`chunk`){this._active&&this._generation===e&&this._deliverEncoded(r.codecId,r.keyframe,new Uint8Array(r.buffer),r.rotation,r.flip);return}if(r.type===`slow`){this._logPath(`encode: ${r.codec} could not keep up with the camera; taking the next rung`);return}if(r.type===`wrongcolor`){this._logPath(`encode: ${r.codec} decodes to the wrong colors on this engine (mean channel error ${r.colErr}); skipping it`);return}if(r.type===`exhausted`){clearTimeout(s),this._logPath(r.rate===void 0?`encode: no codec kept up with the camera; encoding JPEG instead`:`encode: no codec kept up with the camera (${r.codec} reached ${r.rate} fps against ${this.fps} asked for); encoding JPEG instead`),this._stopEncodeWorker(),this._candidateIndex=this._encoderCandidates.length,this._encoderCodecName=`mjpeg`,i();return}(r.type===`unsupported`||r.type===`error`)&&(clearTimeout(s),o(r.type))},t.onerror=e=>{clearTimeout(s),o(`worker.onerror: `+(e&&e.message))},this._encodeWorker=t,this._settleEncodeWorker=a;try{t.postMessage({type:`probe`,width:this.width,height:this.height,fps:this.fps,bitrate:this.bitrate,candidates:this._encoderCandidates})}catch(e){clearTimeout(s),o(`probe postMessage threw: `+e)}})}_watchOrientation(){if(!this._deriveOrientation||this._orientationWatch)return;let e=()=>this._pushOrientation();this._orientationWatch=e,window.addEventListener(`orientationchange`,e),screen.orientation&&screen.orientation.addEventListener&&screen.orientation.addEventListener(`change`,e),e()}_unwatchOrientation(){let e=this._orientationWatch;this._orientationWatch=null,e&&(window.removeEventListener(`orientationchange`,e),screen.orientation&&screen.orientation.removeEventListener&&screen.orientation.removeEventListener(`change`,e))}_pushOrientation(){if(this._encodeWorker){this._orientation={rotation:fr(),flip:!1};try{this._encodeWorker.postMessage({type:`orientation`,...this._orientation})}catch{}}}_stopEncodeWorker(){let e=this._encodeWorker,t=this._settleEncodeWorker;if(this._encodeWorker=null,this._settleEncodeWorker=null,this._workerIsSource=!1,e){e.onmessage=null;try{e.postMessage({type:`stop`})}catch{}setTimeout(()=>{try{e.terminate()}catch{}},100)}t&&t()}async _openSource(e,t){if(!this._workerTrackUnsupported){let n=await this._workerSource(e,t);if(n)return this._deriveOrientation=W(),this._logPath(`capture: MediaStreamTrackProcessor in a worker`),n;if(this._generation!==t)return null}if(typeof MediaStreamTrackProcessor<`u`)try{let n=new MediaStreamTrackProcessor({track:e});return this._logPath(`capture: MediaStreamTrackProcessor on the page`),this._readerSource(n.readable.getReader(),t)}catch{}return typeof VideoFrame>`u`?this._pinJpegRung(`no VideoFrame constructor`):this.encoderPreference===`auto`||this.encoderPreference===`mjpeg`?this._pinJpegRung(`webcam_encoder is ${this.encoderPreference}`):this._logPath(`capture: <video> element sampled with requestVideoFrameCallback`),this._videoSource(e,t)}_pinJpegRung(e){this._stopEncodeWorker(),this._candidateIndex=this._encoderCandidates.length,this._encoderCodecName=`mjpeg`,this._logPath(`capture: <video> element sampled with requestVideoFrameCallback (JPEG: ${e})`)}_readerSource(e,t){return(async()=>{for(;;){let n;try{n=await e.read()}catch{break}if(n.done||this._generation!==t){n.value&&n.value.close();break}this._handleFrame(n.value)}})(),{close:()=>{try{e.cancel()}catch{}}}}_workerSource(e,t){return new Promise(n=>{let r;try{r=e.clone()}catch{n(null);return}let i;try{let e=URL.createObjectURL(new Blob([pr],{type:`text/javascript`}));i=new Worker(e),URL.revokeObjectURL(e)}catch{try{r.stop()}catch{}n(null);return}let a=!1,o=e=>{a||(a=!0,n(e))},s=setTimeout(()=>{i.terminate();try{r.stop()}catch{}o(null)},3e3),c={close:()=>{try{i.postMessage({type:`stop`})}catch{}setTimeout(()=>i.terminate(),100)}};i.onerror=()=>{clearTimeout(s),i.terminate();try{r.stop()}catch{}o(null)},i.onmessage=e=>{let n=e.data;if(n){if(n.type===`ready`)clearTimeout(s),o(c);else if(n.type===`failed`){clearTimeout(s),i.terminate();try{r.stop()}catch{}o(null)}else if(n.type===`frame`){if(i.postMessage({type:`ack`}),this._generation!==t){n.frame.close();return}this._handleFrame(n.frame)}else n.type===`end`&&i.terminate()}};try{i.postMessage({type:`source`,track:r},[r])}catch{clearTimeout(s),i.terminate();try{r.stop()}catch{}o(null)}})}_videoSource(e,t){let n=document.createElement(`video`);n.muted=!0,n.playsInline=!0,n.autoplay=!0,n.style.cssText=`position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;`,document.body.appendChild(n),n.srcObject=new MediaStream([e]);let r=null,i=null,a=null,o=null,s=0,c=()=>{let e=Math.round(performance.now()*1e3);try{return new VideoFrame(n,{timestamp:e})}catch{}try{return a||(a=document.createElement(`canvas`),o=a.getContext(`2d`,{alpha:!1,desynchronized:!0})),(a.width!==n.videoWidth||a.height!==n.videoHeight)&&(a.width=n.videoWidth,a.height=n.videoHeight),o.drawImage(n,0,0),new VideoFrame(a,{timestamp:e})}catch{return null}},l=()=>{if(this._generation===t){if(n.readyState>=2&&n.videoWidth>0){if(typeof VideoFrame<`u`&&this._candidateIndex<this._encoderCandidates.length){let e=c();e?(s=0,this._handleFrame(e)):++s>this.fps&&this._pinJpegRung(`VideoFrames cannot be built from the element`)}else this._handleFrame(n)}n.requestVideoFrameCallback&&(r=n.requestVideoFrameCallback(l))}},u=n.play();return u&&u.catch&&u.catch(()=>{}),n.requestVideoFrameCallback?r=n.requestVideoFrameCallback(l):i=setInterval(l,1e3/this.fps),{close:()=>{if(r!==null&&n.cancelVideoFrameCallback)try{n.cancelVideoFrameCallback(r)}catch{}i!==null&&clearInterval(i);try{n.srcObject=null}catch{}n.remove()}}}_handleFrame(e){if(!this._active||!this._canSend()){sr(e);return}let t=performance.now();if(!this._admit(t)){sr(e);return}if(this._encodeWorker)try{let t=this._frameOrientation(e);this._encodeWorker.postMessage({type:`frame`,frame:e,...t},[e]);return}catch{this._stopEncodeWorker(),sr(e);return}if(typeof VideoEncoder>`u`||this._candidateIndex>=this._encoderCandidates.length){this._encodeJpeg(e);return}let n=e.displayWidth||e.codedWidth,r=e.displayHeight||e.codedHeight,i={rotation:e.rotation||0,flip:!!e.flip};this._orientation=this._frameOrientation(e);let a=this._encodedSize;if(!this._encoder||!a||a.w!==n||a.h!==r||a.rotation!==i.rotation||a.flip!==i.flip){if(this._configuring){e.close();return}this._configuring=!0,this._configureEncoder(n,r,i.rotation,i.flip).then(()=>this._encodeWith(e,n,r,t)).finally(()=>{this._configuring=!1});return}this._encodeWith(e,n,r,t)}_admit(e){let t=1e3/this.fps,n=this._lastFrameMs?e-this._lastFrameMs:t;return this._lastFrameMs=e,this._frameCredit=Math.min(this._frameCredit+n,t*nr),this._frameCredit<t?!1:(this._frameCredit-=t,!0)}_frameOrientation(e){return this._deriveOrientation?{rotation:fr(),flip:!1}:{rotation:e.rotation||0,flip:!!e.flip}}_encodeWith(e,t,n,r){let i=this._encoder;if(!i||i.state!==`configured`||!this._active){e.close();return}let a=i.encodeQueueSize>1;if(this._pace.note(a),this._pace.tooSlow()){this._onEncoderTooSlow(),e.close();return}if(a){e.close();return}let o=this._forceKeyframe||r-this._lastKeyframeMs>=tr;try{i.encode(e,{keyFrame:o}),o&&(this._lastKeyframeMs=r,this._forceKeyframe=!1)}catch(e){this._onEncoderFailure(e)}e.close()}async _configureEncoder(e,t,n=0,r=!1){let i=this._generation;if(this._encoder){try{this._encoder.close()}catch{}this._encoder=null,this._encoderCodec=null}for(;this._candidateIndex<this._encoderCandidates.length;){let a=this._encoderCandidates[this._candidateIndex],o={codec:a.codec,width:e,height:t,bitrate:this.bitrate,framerate:this.fps,latencyMode:`realtime`,...a.extra},s;try{s=await VideoEncoder.isConfigSupported(o)}catch{s=null}if(this._generation!==i)return;if(!s||!s.supported){this._candidateIndex++;continue}try{let c=new VideoEncoder({output:e=>this._onChunk(a,e,i),error:e=>this._onEncoderFailure(e)});c.configure(s.config||o),this._encoder=c,this._encoderCodec=a,this._encodedSize={w:e,h:t,rotation:n,flip:r},this._forceKeyframe=!0,this._logPath(`encoder: ${a.name} (${a.codec}) at ${e}x${t}`);return}catch{this._candidateIndex++}}this._encodedSize=null}_deliverEncoded(e,t,n,r,i){if(!this._canSend()){this._chainBroken=!0;return}if(this._chainBroken&&!t){this.requestKeyframe();return}this._sendFrame(e,t,n,r,i),t&&(this._chainBroken=!1)}_onChunk(e,t,n){if(this._generation!==n||!this._active)return;let r=new Uint8Array(t.byteLength);t.copyTo(r),this._deliverEncoded(e.id,t.type===`key`,r,this._orientation.rotation,this._orientation.flip)}_onEncoderTooSlow(){let e=this._encoderCodec?this._encoderCodec.name:`the encoder`;if(this._encoder){try{this._encoder.close()}catch{}this._encoder=null,this._encoderCodec=null}this._candidateIndex++,this._encodedSize=null,this._pace.reset(),this._logPath(this._candidateIndex>=this._encoderCandidates.length?`encode: ${e} could not keep up with the camera; encoding JPEG instead`:`encode: ${e} could not keep up with the camera; taking the next rung`)}_onEncoderFailure(e){if(console.warn(`Webcam encoder failed, trying the next codec:`,e),this._encoder){try{this._encoder.close()}catch{}this._encoder=null,this._encoderCodec=null}this._candidateIndex++,this._encodedSize=null}_encodeJpeg(e){if(this._jpegBusy){sr(e);return}let t=this._deriveOrientation?fr():0,n=t%180==90,r=e.displayWidth||e.codedWidth||e.videoWidth,i=e.displayHeight||e.codedHeight||e.videoHeight,a=n?i:r,o=n?r:i;this._canvas?(this._canvas.width!==a||this._canvas.height!==o)&&(this._canvas.width=a,this._canvas.height=o):(typeof OffscreenCanvas<`u`?(this._logPath(`encoder: JPEG through OffscreenCanvas`),this._canvas=new OffscreenCanvas(a,o)):(this._logPath(`encoder: JPEG through a page canvas`),this._canvas=document.createElement(`canvas`),this._canvas.width=a,this._canvas.height=o),this._ctx=this._canvas.getContext(`2d`,{alpha:!1,desynchronized:!0}));try{t?(this._ctx.save(),this._ctx.translate(a/2,o/2),this._ctx.rotate(t*Math.PI/180),this._ctx.drawImage(e,-r/2,-i/2,r,i),this._ctx.restore()):this._ctx.drawImage(e,0,0,a,o)}catch{sr(e);return}sr(e),this._jpegBusy=!0;let s=this._generation,c=this._canvas;(c.convertToBlob?c.convertToBlob({type:`image/jpeg`,quality:this.quality}):new Promise((e,t)=>c.toBlob(n=>n?e(n):t(Error(`the canvas gave no JPEG`)),`image/jpeg`,this.quality))).then(e=>e.arrayBuffer()).then(e=>{this._active&&this._generation===s&&this._sendFrame(0,!0,new Uint8Array(e))}).catch(e=>this._onError(e)).finally(()=>{this._jpegBusy=!1})}};function hr(e){if(Ne){window.open(e,`_blank`);return}let t=document.createElement(`iframe`);t.style.cssText=`position:fixed;right:0;bottom:0;width:0;height:0;border:0`,t.addEventListener(`load`,()=>{let n=t.contentWindow;n.addEventListener(`afterprint`,()=>t.remove(),{once:!0});try{n.focus(),n.print()}catch{t.remove(),window.open(e,`_blank`)}}),t.src=e,document.body.appendChild(t)}function gr({automatic:e}){let t=!!e;return{async announce(e,n){let r=new URL(`api/print/`+encodeURIComponent(e),window.location.href).href,i;try{let e=await fetch(r,{headers:_n(),credentials:`same-origin`});if(!e.ok)throw Error(`HTTP ${e.status}`);i=await e.blob()}catch(t){console.warn(`Printed document ${e} (${n} bytes) was not fetched: ${t.message}`);return}let a=URL.createObjectURL(new Blob([i],{type:`application/pdf`}));window.postMessage({type:`printDocument`,name:e,size:i.size,url:a},window.location.origin),t&&!Ne&&hr(a)},setAutomatic(e){t=!!e}}}var _r=`selkies-stream-stats`,vr=3e3;function yr(e){return e===void 0?`unknown`:e===null||e===`NV12`?`hardware`:/^I4/.test(e)?`software`:`unknown`}var br=e=>`${e===null?`Opaque`:e} frames`;function K(e,t,n,r=`hardware_available`){return{decoder:e,decoder_evidence:t,hardware_expected:n,decoder_reason:e===`software`&&n?r:``}}function xr(e,t){return e===!0?K(`hardware`,`A hardware decoder is available`,!0):e===!1?K(`software`,`No hardware decoder for this stream`,!1):K(`unknown`,t,!1)}var Sr=class{constructor(){this.key=``,this.efficient=null}ask(e,t){t!==this.key&&(this.key=t,this.efficient=null,navigator.mediaCapabilities&&navigator.mediaCapabilities.decodingInfo&&navigator.mediaCapabilities.decodingInfo(e).then(e=>{this.key===t&&(this.efficient=e.supported?!!e.powerEfficient:null)}).catch(()=>{}))}};function Cr({forcedSoftware:e,hardwareSupported:t,format:n,capable:r}){if(e)return K(`software`,``,!0,`software_preferred`);if(t===!1)return K(`software`,`No hardware decoder for this stream`,!1);let i=yr(n);return i===`unknown`?xr(r,n===void 0?``:br(n)):K(i,br(n),r===!0)}function wr({implementation:e,powerEfficient:t,trackFormat:n,elementFormat:r,capable:i}){let a=e&&e!==`unknown`?e:``,o=i===!0;if(typeof t==`boolean`)return K(t?`hardware`:`software`,a,o);if(a)return K(/libvpx|ffmpeg|dav1d|openh264|libaom/i.test(a)?`software`:`hardware`,a,o);let s=yr(n);return s===`unknown`?yr(r)===`software`?K(`software`,br(r),o):xr(i,``):K(s,br(n),o)}var Tr=class{constructor({transport:e,send:t,isViewer:n,onOpenChange:r}){this._send=t,this._isViewer=n,this._onOpenChange=r||(()=>{}),this._open=!1,this._subscribed=!1,this._server={},this._serverAt=-1/0,this._bytes=0,this._bytesAt=performance.now(),this._received=0,this._announcing=!1,this._client={transport:e,decoder:`unknown`,decoder_evidence:``,hardware_expected:!1,decoder_reason:``,codec:``,resolution:``,path:``,sink:``,decode_path:``,connection:`ok`},window.stream_info=null,window.stream_client=this._client,window.stream_stats={open:!1,latest:null,history:[]}}get open(){return this._open}_changed(){this._announcing||typeof window.dispatchEvent!=`function`||(this._announcing=!0,queueMicrotask(()=>{this._announcing=!1,window.dispatchEvent(new Event(_r))}))}setOpen(e){e=!!e,e!==this._open&&(this._open=e,this._bytes=0,this._bytesAt=performance.now(),this._received=0,window.stream_stats={open:e,latest:null,history:[]},this.subscribe(),this._onOpenChange(e),this._changed())}subscribe(){let e=this._open&&!this._isViewer();if(e||this._subscribed){this._subscribed=e;try{this._send(`_stats,${+!!e}`)}catch{this._subscribed=!1}}}disconnected(){this._subscribed=!1,this.setConnection(!1)}setConnection(e){this.setClient({connection:e?`poor`:`ok`})}setInfo(e){window.stream_info=e||null,this._changed()}setClient(e){let t=this._client;Object.keys(e).every(n=>t[n]===e[n])||(Object.assign(t,e),this._changed())}serverSample(e){this._server=e||{},this._serverAt=performance.now();let t=window.stream_stats.latest;this._open&&t&&!t.server&&(Object.assign(t,this._server,{server:!0}),this._changed())}noteBytes(e){this._bytes+=e,this._received+=e}clientSample(e){if(!this._open)return;let t=performance.now(),n=(t-this._bytesAt)/1e3,r=t-this._serverAt<=vr,i=Object.assign({t:Date.now(),server:r},r?this._server:{},e);i.mbps===void 0&&n>0&&(i.mbps=Math.round(this._bytes*8/1e6/n*100)/100),i.received_mb=Math.round(this._received/1e4)/100,this._bytes=0,this._bytesAt=t;let a=window.stream_stats;a.latest=i,a.history.push(i),a.history.length>600&&a.history.shift(),this._changed()}};function Er(e){let t=()=>performance.timeOrigin+performance.now(),n=0,r=0,i=0,a=0,o=0,s=0,c=NaN,l=!1,u=(e,t)=>{n+=e,t>=0&&(r+=t,i++)},d=()=>{l=!1,s&&=(u(1,t()-c),a+=s-1,0)};return{drawn(t){s++,c=t,e?l||(l=!0,e(d)):d()},land:d,presented:u,superseded(e){a+=e},refused(){o++},take(){let e={presented:n,delaySum:r,delays:i,superseded:a,refused:o};return n=0,r=0,i=0,a=0,o=0,e},reset(){n=0,r=0,i=0,a=0,o=0,s=0}}}function Dr(e,t,n){let r=()=>typeof e.getVideoPlaybackQuality==`function`?e.getVideoPlaybackQuality():{totalVideoFrames:0,droppedVideoFrames:0},i=typeof e.requestVideoFrameCallback==`function`,a=r(),o=a.totalVideoFrames,s=a.droppedVideoFrames,c=0,l=0,u=-1,d=0,f=0,p=!1,m=!1,h=()=>{l=0,c=e.requestVideoFrameCallback(g)},g=(e,i)=>{d+=u>=0&&i.presentedFrames>u?i.presentedFrames-u:1,u=i.presentedFrames,p=!0,t.presented(0,n(i)),m||=r().totalVideoFrames!==a.totalVideoFrames,m?l=setTimeout(h,100):h()};return i&&h(),{reported:()=>p,stop:()=>{clearTimeout(l),i&&e.cancelVideoFrameCallback(c)},read(){let e=r(),t=e.totalVideoFrames<o||e.droppedVideoFrames<s,n=t?e.totalVideoFrames:e.totalVideoFrames-o,i=t?e.droppedVideoFrames:e.droppedVideoFrames-s;o=e.totalVideoFrames,s=e.droppedVideoFrames;let a=d-f;return f=d,{shown:n>0?Math.max(0,n-i):a,dropped:i}}}}var Or=`display`,kr=2e3,Ar=8,jr=1e3,Mr=.4,Nr=.8,Pr=.15,Fr=5e-4,Ir=250;function Lr(e){let t=[];for(let n=1;n<e.length;n++){let r=e[n]-e[n-1];r>0&&r<250&&t.push(r)}if(t.length<30)return null;let n=t.slice().sort((e,t)=>e-t),r=n.filter(e=>e<=1.5*n[Math.floor(n.length/10)]),i=r[r.length>>1];for(let n=0;n<2;n++)if(!(i>=1e3/jr&&i<=1e3/Ar)||(i=Rr(e,i,t.length),i===null))return null;let a=1e3/i;return a>=Ar&&a<=jr?a:null}function Rr(e,t,n){let r=[],i=[[0,e[0]]],a=0;for(let n=1;n<e.length;n++){let o=e[n]-e[n-1],s=Math.round(o/t);o<=0||o>=250||s<1||Math.abs(o-s*t)>Mr*t?(r.push(i),i=[[0,e[n]]]):(i.push([i[i.length-1][0]+s,e[n]]),a++)}if(r.push(i),a<Nr*n)return null;let o=r.filter(e=>e.length>=3).map(e=>({r:e,n:e.reduce((e,t)=>e+t[0],0)/e.length,t:e.reduce((e,t)=>e+t[1],0)/e.length})),s=0,c=0,l=0;for(let{r:e,n:t,t:n}of o){for(let[r,i]of e)s+=(r-t)*(i-n),c+=(r-t)*(r-t);l+=e[e.length-1][0]}if(l<30||c===0)return null;let u=s/c,d=0,f=0;for(let{r:e,n:t,t:n}of o)for(let[r,i]of e)d+=(i-n-(r-t)*u)**2,f++;let p=Math.sqrt(d/f);return p>Pr*u||p/Math.sqrt(c)>1e-4*u?null:u}function zr(e){let t=Math.round(e),n=Math.round(e*1.001)*1e3/1001,r=Math.abs(n-e)<Math.abs(t-e)?n:t;return Math.abs(r-e)<=.001*r?r:Math.round(e*100)/100}function Br(e,t,n){for(let r=1;e/r>=t;r++)if(e/r<=n)return e/r;return e<t?t:n}function Vr(e,t){return e===`display`&&!(t&&t.min===t.max)}function Hr(e,t,n){if(e!==null&&e!==`display`){let t=parseFloat(e);return Number.isFinite(t)?t:null}return!n||!t||!Vr(e,n)?null:Br(t,n.min,n.max)}function Ur(e){let t=null,n=[],r=0,i=!1,a=kr,o=null,s=r=>{if(i=!1,n=[],r===null)return;let a=zr(r);(t===null||Math.abs(a-t)>Fr*t)&&(t=a,e(t))},c=e=>{if(!i)return;n.push(e);let t=e-n[0];if(t>=a){a=t+Ir;let e=Lr(n);if(e!==null||t>=8e3){s(e);return}}r=requestAnimationFrame(c)},l=()=>{i||document.visibilityState!==`visible`||(i=!0,n=[],a=kr,r=requestAnimationFrame(c))},u=()=>{document.visibilityState===`visible`?l():i&&(cancelAnimationFrame(r),i=!1,n=[])},d=()=>{o=window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`),o.addEventListener(`change`,f,{once:!0})},f=()=>{d(),l()},p=window.screen,m=!!(p&&typeof p.addEventListener==`function`);return document.addEventListener(`visibilitychange`,u),document.addEventListener(`fullscreenchange`,l),m&&p.addEventListener(`change`,l),d(),l(),{rate:()=>t,measure:l,stop(){i&&cancelAnimationFrame(r),i=!1,document.removeEventListener(`visibilitychange`,u),document.removeEventListener(`fullscreenchange`,l),m&&p.removeEventListener(`change`,l),o.removeEventListener(`change`,f)}}}var Wr=[`encoder`,`framerate`,`video_crf`,`video_fullcolor`,`video_10bit`,`video_streaming_mode`,`jpeg_quality`,`paint_over_jpeg_quality`,`use_paint_over_quality`,`video_paintover_crf`,`video_paintover_burst_frames`,`video_bitrate`,`rate_control_mode`,`use_cpu`,`cpu_encode_threading`,`audio_bitrate`],Gr={video_fullcolor:`false`,video_10bit:`false`,framerate:`60`,video_crf:`25`,manual_resolution:`false`,manual_width:null,manual_height:null},Kr=[...new Set([...Object.keys(Gr),...Wr.filter(e=>e!==`encoder`)])],qr=(e,t)=>({encoderPick:`${e(`encoder`)}_pick`,fallbackTab:`${e(`encoder`)}_pick_tab`,displayTab:`${t}_display_settings_tab`}),Jr=(e,t)=>`${e(t)}_pick`;function Yr(e,t){let n=qr(e,t);try{if(window.sessionStorage.getItem(n.fallbackTab)!==null||window.sessionStorage.getItem(n.displayTab)!==null)return;for(let t of[`encoder`,...Kr]){let n=e(t),r=window.localStorage.getItem(Jr(e,t));r!==null&&(r===``?window.localStorage.removeItem(n):window.localStorage.setItem(n,r),window.localStorage.removeItem(Jr(e,t)))}}catch{}}function Xr(e,t,n,r){let i={};try{for(let t of Wr){if(n[t]===void 0||n[t]===null)continue;let r=e(t),a=String(n[t]);if(window.localStorage.getItem(r)===a)continue;let o=Jr(e,t);window.localStorage.getItem(o)===null&&window.localStorage.setItem(o,window.localStorage.getItem(r)??``),window.localStorage.setItem(r,a),i[t]=n[t]}Object.keys(i).length>0&&window.sessionStorage.setItem(qr(e,t).displayTab,r)}catch{}return i}function Zr(e,t){try{for(let n of t)(n===`encoder`||Kr.includes(n))&&window.localStorage.removeItem(Jr(e,n))}catch{}}Fn(),bn();var Qr=null,$r=!1,ei=null;Nn().then(e=>{if(Qr=e,e&&$r&&ei)try{ei.sendDataChannelMessage(`SETTINGS,${JSON.stringify({keyboardLayout:e})}`)}catch{}});var ti=0,ni=!0;function ri(){let e=document.createElement(`style`);e.textContent=`
	body {
		background-color: #000000;
		font-family: sans-serif;
		margin: 0;
		padding: 0;
		overflow: hidden;
		background-color: #000;
		color: #fff;
	}

	#app {
		display: flex;
		flex-direction: column;
		height: calc(var(--vh, 1vh) * 100);
		width: 100%;
	}

	.video-container {
		flex-grow: 1;
		flex-shrink: 1;
		display: flex;
		flex-direction: column;
		justify-content: center;
		align-items: center;
		height: 100%;
		width: 100%;
		position: relative;
		overflow: hidden;
	}

	.video-container video,
	.video-container #overlayInput{
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
	}

	.video-container video {
		max-width: none;
		max-height: none;
		object-fit: contain;
	}

	.video-container #overlayInput {
		opacity: 0;
		z-index: 3;
		caret-color: transparent;
		background-color: transparent;
		color: transparent;
		pointer-events: auto;
		-webkit-user-select: none;
		border: none;
		outline: none;
		padding: 0;
		margin: 0;
	}

	.video-container #playButton {
		position: absolute;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		z-index: 10;
	}

	.video-container .status-bar {
		position: absolute;
		bottom: 0;
		left: 0;
		width: 100%;
		padding: 5px;
		background-color: rgba(0, 0, 0, 0.7);
		color: #fff;
		text-align: center;
		z-index: 5;
	}

	.loading-text {
		margin-top: 1em;
	}

	.hidden {
		display: none !important;
	}

	#playButton {
		padding: 15px 30px;
		font-size: 1.5em;
		cursor: pointer;
		background-color: rgba(0, 0, 0, 0.5);
		color: white;
		border: 1px solid rgba(255, 255, 255, 0.3);
		border-radius: 3px;
		backdrop-filter: blur(5px);
	`,document.head.appendChild(e)}function ii(){let e,t=25,n=8e3,r=60,s=null,c=null,l=null,u=128e3,d=!1,f=!1,p=!1,m=(e,t)=>{e.push(t),e.length>1e3&&e.shift()},h=[],g=[];window.selkiesLogs={log:h,debug:g};let _=`connecting`,ee=`disabled`,te=!0,ne=!0,re=!0,ie=[],ae=``,oe=`cbr`,v={gamepadState:`disconnected`,gamepadName:`none`},y={connectionStatType:`unknown`,connectionLatency:0,connectionVideoLatency:0,connectionAudioLatency:0,connectionAudioCodecName:`NA`,connectionAudioBitrate:0,connectionPacketsReceived:0,connectionPacketsLost:0,connectionBytesReceived:0,connectionBytesSent:0,connectionCodec:`unknown`,connectionVideoDecoder:`unknown`,connectionResolution:``,connectionFrameRate:0,connectionVideoBitrate:0,connectionAvailableBandwidth:0};var b=null;let x=!1,ce=null,le=0,ue=!1,de=!1;var fe=null;let pe=null,me=null,he=null,_e=0,ye=!1,be=!1,xe=!1,Se=!1,Te=null,S=null,C=null,w=500,T=!1,E,D=0;window.manualResolution=!1,window.fps=0,window.currentAudioBufferSize=0;let Ne=!1;var Fe=``,Ie=!1,O=null;let ze=null,Be=new Sr,Ve={key:``,track:void 0,element:void 0,current:!1,reading:!1},Ue=Er(null),We=null,Ge=0,Ke=new Tr({transport:`webrtc`,send:e=>{let t=O&&O._send_channel;if(!t||t.readyState!==`open`)throw Error(`not connected`);O.sendDataChannelMessage(e)},isViewer:()=>F,onOpenChange:e=>{ze=null,We&&We.stop(),We=null,e&&(Ve.current=!1,si())}});var k=null;let qe=null,Je=null,Ye=null,Xe=!1,Ze=96,A=!0,Qe=!0,$e=new Set,et=!1,j=!1,tt=!1,nt=!1,rt=!1,it=!1,at=`auto`,ot=!0,M=()=>{let e=O!==void 0&&O&&O.peerConnection&&O.peerConnection.sctp&&O.peerConnection.sctp.maxMessageSize||0;return(e>0?Math.min(e,1048576):262144)-512},st=`controller`,ct=`viewer`,N=null,lt=0,ut=null,dt=null,ft=!0,pt=!1,mt=!0,ht=!0,gt=!1,_t=!1,vt=!0,yt=new En,bt=Xt(),xt=()=>bt.arm(),St=()=>bt.consume(),Ct=e=>yt.reencodePng(e).then(e=>e.result).catch(()=>Gt(e)),wt=(()=>{let e=/iPad|iPhone|iPod/.test(navigator.userAgent)||navigator.platform===`MacIntel`&&navigator.maxTouchPoints>1,t=/Firefox|FxiOS/.test(navigator.userAgent),n=/CriOS/.test(navigator.userAgent);return((navigator.userAgentData&&navigator.userAgentData.brands||[]).some(e=>/Chromium|Google Chrome/.test(e.brand))||window.chrome!==void 0)&&!e&&!t&&!n})(),Tt=ln({isChromium:wt,canRead:()=>!!te,sendRequest:()=>O.sendDataChannelMessage(`REQUEST_CLIPBOARD`),digestBytes:async e=>{let{byteLength:t,hash:n}=await yt.hashBytes(e);return Wt(t,n)}}),P=nn(),Et=on({worker:yt,clipboardSync:Tt,writer:P,toPng:Ct,canWriteLocal:()=>re&&ee===`enabled`&&ne,binaryEnabled:()=>vt,isChromium:wt,onPreview:(e,t)=>window.postMessage(cn(e,t),window.location.origin),onImageWritten:e=>(console.log(`Successfully wrote image (${e}) from server to local clipboard.`),window.postMessage({type:`clipboardContentUpdate`,text:`Image (${e}) received from session and copied to clipboard.`},window.location.origin),Tt.captureLocalImageSig()),onImageWriteFailed:e=>hi(e)}),Dt=fn();if(Dt===`#shared`)ut=ct,dt=-1,N=`shared`,lt=void 0;else if(Dt.startsWith(`#player`)){ut=ct;let e=parseInt(Dt.substring(7),10);dt=e||null,e>=2&&e<=4&&(N=`player${e}`,lt=e-1)}else ut=st,dt=1,lt=0;let F=N!==null,Ot=N===`shared`,kt=!1,I=ke(),At=null,jt=(e,t)=>{try{window.localStorage.setItem(e,t)}catch(t){console.warn(`Selkies: could not persist '${e}' to localStorage:`,t)}},L=fn().startsWith(`#display2`)?`display2`:`primary`,Mt=null,Nt=!1,R=!1;function Pt(){return Lt({useCssScaling:Xe,localScale:Ze/96,manual:window.manualResolution,displayId:L,layouts:Mt,shared:F,wayland:Nt})}let z=0,B=0,It=0;function Rt(){let e=Pt();k&&k.setStreamDensity&&k.setStreamDensity(e);let t=z>0&&Math.abs(e-z)>1e-6;z=e,t&&L!==`primary`&&!window.manualResolution&&(console.log(`Stream density changed: ${e}.`),kr())}let zt=[`framerate`,`video_crf`,`video_fullcolor`,`video_10bit`,`video_streaming_mode`,`use_cpu`,`cpu_encode_threading`,`video_paintover_crf`,`video_paintover_burst_frames`,`use_paint_over_quality`,`manual_resolution`,`manual_width`,`manual_height`,`encoder`,`scaleLocallyManual`,`use_browser_cursors`,`rate_control_mode`,`video_bitrate`,`force_aligned_resolution`,`scaling_dpi`],Bt=e=>{let t=`${I}_${e}`;return L===`display2`&&zt.includes(e)?`${t}_${L}`:t};Yr(Bt,I);let V=(e,t)=>{let n=Bt(e),r=window.localStorage.getItem(n);return r==null?t:parseInt(r)},qt=(e,t)=>{let n=Bt(e),r=window.localStorage.getItem(n),i=parseFloat(r);return r==null||isNaN(i)?t:i},Jt=(e,t)=>{let n=Bt(e);t==null?window.localStorage.removeItem(n):jt(n,t.toString())},H=(e,t)=>{let n=Bt(e),r=window.localStorage.getItem(n);return r===null?t:r.toString().toLowerCase()===`true`},U=(e,t)=>{let n=Bt(e);t==null?window.localStorage.removeItem(n):jt(n,t.toString())},Yt=(e,t)=>{let n=Bt(e);return window.localStorage.getItem(n)??t},Zt=(e,t)=>{let n=Bt(e);t==null?window.localStorage.removeItem(n):jt(n,t.toString())};var Qt=e=>{var t=new Date;return`[`+(t.getHours()+`:`+t.getMinutes()+`:`+t.getSeconds())+`] `+e};let $t=e=>{let t=_t?16:2;return Math.floor(e/t)*t};function en(){let e=mt,t=fn().startsWith(`#display2`)||gt,n=t?!0:e;k&&typeof k.setUseBrowserCursors==`function`&&(console.log(`Applying effective cursor setting. Multi-monitor: ${t}, User Pref: ${e}, Final: ${n}`),k.setUseBrowserCursors(n));try{window.postMessage({type:`effectiveCursorState`,value:n},window.location.origin)}catch{}}function rn(){k&&typeof k.setRawPointerMotion==`function`&&k.setRawPointerMotion(ht)}let an=1;function sn(){k&&typeof k.setTrackpadSpeed==`function`&&k.setTrackpadSpeed(an)}let dn=!0;function pn(){k&&typeof k.setGamepadRumble==`function`&&k.setGamepadRumble(dn)}let mn=!0;function hn(){k&&typeof k.setMacCmdAsCtrl==`function`&&k.setMacCmdAsCtrl(mn)}let vn=!0,yn=null;function bn(){k&&typeof k.setShortcutsEnabled==`function`&&k.setShortcutsEnabled(vn)}function xn(e){return Rn(Xn,e,{macDesktop:Ae()},e=>Yt(e,null))}function Cn(e){return Rn(Zn,e,{macDesktop:Ae()},e=>Yt(e,null))}function wn(e){let t=Bt(`useCssScaling`),n=window.localStorage.getItem(`${t}_explicit_choice`)===`true`,r=Rn(zn,e,{manualActive:!!window.manual_resolution||window.manual_width>0},()=>n?window.localStorage.getItem(t):null);return zn.toServer(r)}function Tn(){d=!1,Te&&Te.classList.add(`hidden`),O.playStream(),Dn()}let Dn=async()=>{if(pe===null){if(`wakeLock`in navigator)try{pe=await navigator.wakeLock.request(`screen`),pe.addEventListener(`release`,()=>{console.log(`Screen Wake Lock was released automatically.`),pe=null}),console.log(`Screen Wake Lock is active.`)}catch(e){console.warn(`Could not acquire Wake Lock: ${e.name}, ${e.message}`)}else console.warn(`Wake Lock API is not supported by this browser.`)}},On=async()=>{pe!==null&&(await pe.release(),pe=null)},An=null,jn=!1,Mn=null,Nn=0;function Pn(){Mn!==null&&(clearTimeout(Mn),Mn=null),Nn=0}function Fn(){Mn!==null&&clearTimeout(Mn);let e=b?b.currentTime:0;Mn=setTimeout(()=>In(e),3e3)}function In(e){if(Mn=null,document.hidden||!O||Vn||d||!A){Nn=0;return}if(b&&b.currentTime>e&&b.readyState>=HTMLMediaElement.HAVE_CURRENT_DATA){Nn=0;return}if(b&&b.paused&&b.play().catch(()=>{}),Nn++,Nn<=3){console.warn(`No video after connecting or resuming; resend attempt ${Nn}/3.`);try{O.sendDataChannelMessage(`START_VIDEO`)}catch{}Fn();return}Nn=0,!x&&(typeof window<`u`&&window.__selkiesModeSwitching||(console.warn(`[webrtc] no video after connecting or resuming; reconnecting in place.`),O.signaling.reconnect()))}async function Ln(){if(document.hidden){Pn(),An===null&&(An=setTimeout(()=>{if(An=null,document.hidden&&!jn&&O&&A){jn=!0;try{O.sendDataChannelMessage(`STOP_VIDEO`)}catch{}console.log(`Tab hidden: sent STOP_VIDEO to pause this peer's feed.`)}},250));return}if(An!==null&&(clearTimeout(An),An=null),jn){if(jn=!1,O)try{O.sendDataChannelMessage(`START_VIDEO`)}catch{}console.log(`Tab visible: sent START_VIDEO to resume this peer's feed.`),Fn()}else b&&b.paused&&b.play().catch(()=>{});pe===null&&await Dn()}async function Bn(){if(me&&b){if(!(`setSinkId`in HTMLMediaElement.prototype)||typeof b.setSinkId!=`function`){console.warn(`setSinkId not supported; cannot select audio output device.`);return}try{await b.setSinkId(me),console.log(`Playback output set to device: ${me}`)}catch(e){console.error(`Failed to set audio output device: ${e.name}, ${e.message}`)}}}let Vn=!1;function Hn(){S&&!Vn&&(S.textContent=_&&_.charAt(0).toUpperCase()+_.slice(1),_==`connected`&&(S.classList.add(`hidden`),Te&&d&&Te.classList.remove(`hidden`)))}function Un(){if(!b)return;if(!ft){b.style.imageRendering!==`pixelated`&&(b.style.imageRendering=`pixelated`);return}let e=window.devicePixelRatio||1,t=b.getBoundingClientRect();wt&&Math.abs(b.videoWidth-t.width*e)<=16&&Math.abs(b.videoHeight-t.height*e)<=16?b.style.imageRendering!==`pixelated`&&(console.log(`Setting video rendering to 'pixelated' for sharp display.`),b.style.imageRendering=`pixelated`):b.style.imageRendering!==`auto`&&(console.log(`Setting video rendering to 'auto' for smooth upscaling.`),b.style.imageRendering=`auto`)}function Wn(e){console.log(`Sanitizing and storing settings based on server payload.`);let t={};for(let n in e){if(!Object.prototype.hasOwnProperty.call(e,n))continue;let r=e[n],i=$n(n),a=Bt(i),o=window.localStorage.getItem(a)===null;if(r.min!==void 0&&r.max!==void 0){let e=qt(i,r.default);o?window[n]=e:e<r.min||e>r.max?(console.log(`Sanitizing '${n}': stored value ${e} out of range [${r.min}-${r.max}]. Reverting to server default ${r.default}.`),window.localStorage.removeItem(a),window[n]=r.default,t[n]=r.default):window[n]=e}else if(r.allowed!==void 0){let e=!isNaN(parseFloat(r.allowed[0])),s=e?V(i,parseInt(r.value,10)).toString():Yt(i,r.value),c=t=>{window[n]=e?parseInt(t,10):t};o?c(r.value):r.allowed.includes(s)?(c(s),e?Jt(i,parseInt(s,10)):Zt(i,s)):(console.log(`Sanitizing '${n}': stored "${s}" not in allowed [${r.allowed.join(`, `)}]. Reverting to server default "${r.value}".`),window.localStorage.removeItem(a),c(r.value),t[n]=r.value)}else if(typeof r.value==`boolean`){let e=r.value;if(r.locked){let r=H(i,!e);r!==e&&(console.log(`Sanitizing '${n}': setting is locked by server. Client value ${r} is being overwritten with ${e}.`),t[n]=e),window[n]=e}else if(o)window[n]=e,r.overridden&&(t[n]=e);else{let t=H(i,e);window[n]=t,U(i,t)}}else r.value!==void 0&&(window[n]=r.value)}return t}function Gn(){try{return RTCRtpReceiver.getCapabilities(`video`).codecs.some(e=>/^video\/vp9$/i.test(e.mimeType)&&/(^|;)profile-id=1(;|$)/.test(e.sdpFmtpLine||``))}catch{return!1}}async function Kn(){let e=i(ae);a(e)&&!await qn(e)&&H(`video_fullcolor`,!1)&&(console.warn(`[Selkies] full color (4:4:4) is off: this browser decodes ${e} 4:2:0 only over WebRTC.`),U(`video_fullcolor`,!1))}async function qn(e){return e===`vp9`?Gn():await ve(e)}let Jn=!1;async function Yn(){if(!window.video_fullcolor||F)return;let e=i(ae);if(a(e)&&!await qn(e)&&window.video_fullcolor){if(Jn){console.error(`This session streams ${e} 4:4:4, which this browser cannot decode over WebRTC.`);return}console.warn(`[Selkies] full color (4:4:4) is off: this browser decodes ${e} 4:2:0 only over WebRTC.`),window.video_fullcolor=!1,U(`video_fullcolor`,!1),Lr({video_fullcolor:!1},!1)}}function Qn(e,t){let n=RegExp(`^video/${e}$`,`i`),r=RegExp(`(^|;)profile-id=${t}(;|$)`);try{return RTCRtpReceiver.getCapabilities(`video`).codecs.some(e=>n.test(e.mimeType)&&r.test(e.sdpFmtpLine||``))}catch{return!1}}async function er(e,t){if(e===`av1`&&wt)return!1;if(e===`vp9`)return Qn(`vp9`,t?3:2);if(e===`h265`&&!t)return Qn(`h265`,2);if(e===`h264`&&!t)try{return RTCRtpReceiver.getCapabilities(`video`).codecs.some(e=>/^video\/h264$/i.test(e.mimeType)&&/profile-level-id=6e/i.test(e.sdpFmtpLine||``))}catch{return!1}return await we(e,t)}let tr=e=>!!window.video_fullcolor&&a(e);async function nr(){let e=i(ae);o(e)&&H(`video_10bit`,!1)&&(await er(e,H(`video_fullcolor`,!1)&&a(e))||(console.warn(`[Selkies] 10-bit is off: this browser decodes ${e} at 8 bits only over WebRTC.`),U(`video_10bit`,!1)))}let ir=!1;async function ar(){if(!window.video_10bit||F)return;let e=i(ae);if(o(e)&&!await er(e,tr(e))&&window.video_10bit){if(ir){console.error(`This session streams 10-bit ${e}, which this browser cannot decode over WebRTC.`);return}console.warn(`[Selkies] 10-bit is off: this browser decodes ${e} at 8 bits only over WebRTC.`),window.video_10bit=!1,U(`video_10bit`,!1),Lr({video_10bit:!1},!1)}}function or(){let e=b?b.getBoundingClientRect():null,t=(Mt||{})[L];return Ut({stream:b&&b.videoWidth>0?[b.videoWidth,b.videoHeight]:null,css:e&&e.width>0?[e.width,e.height]:null,realized:t?[t.w,t.h]:null,density:Pt()})}function sr(){return Hr(window.localStorage.getItem(Bt(`framerate`)),c?c.rate():null,s)}function cr(){let e=sr();e!==null&&e!==l&&$r&&(r=l=e,O.sendDataChannelMessage(`_arg_fps,${e}`))}function lr(){if(F){console.log(`Skipping sending client persisted settings in shared mode.`);return}let e=`${I}_`,t={};B=Pt();let n=[`encoder`,`manual_resolution`,`audio_bitrate`,`video_bitrate`,`scaling_dpi`,`enable_binary_clipboard`,`rate_control_mode`,`video_crf`,`use_cpu`,`cpu_encode_threading`,`force_aligned_resolution`,`video_fullcolor`,`video_10bit`,`video_streaming_mode`,`use_paint_over_quality`,`video_paintover_crf`,`video_paintover_burst_frames`],r=[`manual_resolution`,`enable_binary_clipboard`,`use_cpu`,`cpu_encode_threading`,`video_fullcolor`,`video_10bit`,`video_streaming_mode`,`use_paint_over_quality`,`force_aligned_resolution`],i=[`audio_bitrate`,`scaling_dpi`,`video_crf`,`video_paintover_crf`,`video_paintover_burst_frames`,`video_bitrate`];for(let a in localStorage)if(Object.hasOwnProperty.call(localStorage,a)&&a.startsWith(e)){let o=a.substring(e.length),s=o;if(o.endsWith(`_display2`)){if(L!==`display2`)continue;s=o.slice(0,-9)}else if(L===`display2`&&zt.includes(o))continue;if(n.includes(s)){if((s===`use_paint_over_quality`||s===`cpu_encode_threading`)&&localStorage.getItem(`${a}_explicit_choice`)!==`true`)continue;let e=localStorage.getItem(a);if(r.includes(s))e=e===`true`;else if(i.includes(s)&&(e=parseInt(e,10),isNaN(e)))continue;t[s]=e}}t.encoder!==void 0&&!ge(t.encoder)&&(console.log(`Not asking for ${t.encoder}: this browser receives no such WebRTC codec.`),delete t.encoder),window.manualResolution&&E!=null&&D!=null&&(t.manual_resolution=!0,t.manual_width=$t(E),t.manual_height=$t(D)),t.scaling_dpi===void 0&&(t.scaling_dpi=W()),l=sr(),l!==null&&(t.framerate=l),Qr&&(t.keyboardLayout=Qr),t.useCssScaling=Xe,t.displayScale=It=or();try{let e=JSON.stringify(t);O.sendDataChannelMessage(`SETTINGS,${e}`),$r=!0,console.log(`Sent initial settings to server:`,t)}catch(e){console.error(`Error constructing or sending initial settings:`,e)}}function ur(e,t,n){if(e<=0||t<=0){console.log(`Invalid target height or width`);return}let r=window.manualResolution?1:Pt(),i=$t(e*r),a=$t(t*r);console.log(`applyManualStyle logicalWidth: ${i} logicalHeight: ${a}`),(b.width!==i||b.height!==a)&&(b.width=i,b.height=a,console.log(`Video Element set to: ${e}x${t}`));let o=b.parentElement,s=o.clientWidth,c=o.clientHeight;if(n){let n=e/t,r=s/c,i,a;n>r?(i=s,a=s/n):(a=c,i=c*n);let o=(c-a)/2,l=(s-i)/2;b.style.position=`absolute`,b.style.width=`${i}px`,b.style.height=`${a}px`,b.style.top=`${o}px`,b.style.left=`${l}px`,b.style.objectFit=`contain`,console.log(`Applied manual style (Scaled): CSS ${i}x${a}, Pos ${l},${o}`)}else{let n=window.devicePixelRatio||1,r=e/n,i=t/n,a=(c-i)/2,o=(s-r)/2;b.style.position=`absolute`,b.style.width=`${r}px`,b.style.height=`${i}px`,b.style.top=`${a}px`,b.style.left=`${o}px`,b.style.objectFit=`fill`,console.log(`Applied manual style (Exact): CSS ${r}x${i}, Pos ${o},${a}`)}Un()}function dr(e,t){if(!b)return;let n=Pt(),r=$t(e*n),i=$t(t*n);console.log(`resetToWinRes logicalWidth: ${r} logicalHeight: ${i}`),(b.width!==r||b.height!==i)&&(b.width=r,b.height=i,console.log(`Video Element set to: ${r}x${i}`)),b.style.position=`absolute`,b.style.width=`${Math.round(e)}px`,b.style.height=`${Math.round(t)}px`,b.style.top=`0px`,b.style.left=`0px`,b.style.objectFit=`fill`,Un(),console.log(`Resized to window resolution: ${r}x${i} (css ${e}x${t})`)}function fr(){return window.manualResolution?Ht(E,D):Vt()}function W(){return Xe&&!window.manualResolution?96:Ze}function pr(){try{O.sendDataChannelMessage(`s,${W()}`)}catch{}}function G(e){if(F||Yt(`scaling_dpi`,null)!==null)return!1;let t=fr();return t!==Ze&&(Ze=t,console.log(`DPI follows ${e}: scaling_dpi -> ${t}.`),window.postMessage({type:`scalingDpiFollowed`,value:t},window.location.origin),!0)}let mr=window.devicePixelRatio||1;function _r(){let e=window.devicePixelRatio||1;e!==mr&&(mr=e,G(`devicePixelRatio changed`)&&pr(),F||Un())}function vr(e,t){let n=window.manualResolution?1:Pt();return[Math.min($t(e*n),4080),Math.min($t(t*n),4080),n]}function yr(e,t){if(F){console.log(`Skipping sending resolution in shared mode.`);return}let[n,r,i]=vr(e,t);window.manualResolution||(z=i,B>0&&Math.abs(i-B)>1e-6&&setTimeout(()=>lr(),0));let a=`${n}x${r}`;fe=[n,r],console.log(`Sending resolution to server: ${a}, Pixel Ratio Used: ${i}, useCssScaling: ${Xe}`),O.sendDataChannelMessage(`r,${a}`)}function br(){window.addEventListener(`resize`,xr)}function K(){window.removeEventListener(`resize`,xr)}window.addEventListener(`resize`,()=>{window.manualResolution&&!F&&E>0&&D>0&&b&&b.parentElement&&ur(E,D,be)});function xr(){_r(),C=new Date,T===!1&&(T=!0,setTimeout(()=>{Cr()},w))}function Cr(){new Date-C<w?setTimeout(()=>{Cr()},w):(T=!1,kr())}function kr(){if(window.manualResolution||window.enable_resize===!1&&L!==`display2`)return;ie=k.getWindowResolution();let e=Pt();z=e,k&&k.setStreamDensity&&k.setStreamDensity(e),ie[0]*e>4080&&(ie[0]=Math.floor(4080/e)),ie[1]*e>4080&&(ie[1]=Math.floor(4080/e)),yr(ie[0],ie[1]),dr(ie[0],ie[1])}(()=>{let e=null,t=()=>{_r(),!window.manualResolution&&!F&&xr(),n()},n=()=>{if(e)try{e.removeEventListener(`change`,t)}catch{}let n=window.devicePixelRatio||1;e=window.matchMedia(`(resolution: ${n}dppx)`),e.addEventListener(`change`,t,{once:!0})};n(),setInterval(()=>{(window.devicePixelRatio||1)!==mr&&t()},1e3)})();function Ar(){if(F){console.log(`Skipping loading last session settings in shared mode.`);return}if(O&&pr(),k&&k.resumePointerEcho(),window.manualResolution&&E&&D)console.log(`Applying manual resolution: ${E}x${D}`),ur(E,D,be),fn().startsWith(`#display2`)&&yr(E,D);else{console.log(`Applying window resolution`);let e=k.getWindowResolution();dr(...e),(window.enable_resize!==!1||L===`display2`)&&yr(e[0],e[1]),br()}}function jr(){let e={type:`sidebarButtonStatusUpdate`,video:A,audio:Qe,microphone:j,webcam:tt,gamepad:ot};console.log(`Posting sidebarButtonStatusUpdate:`,e),window.postMessage(e,window.location.origin)}function Mr(e,t=!1){O.setMicrophone(e,he).then(t=>{j=e&&t===!0,jr()}).catch(n=>{console.error(`Microphone toggle failed:`,n),j=!1,e&&t&&Pe(n)&&(rt=!0),jr()})}async function Nr(e=!1){if(!(F||!O||tt||nt)){nt=!0;try{let t=await O.setWebcam(!0,null,{codec:at});if(t){let e=O.webcamTrack;e&&e.addEventListener(`ended`,()=>{tt&&Pr()}),tt=!0}else tt=!1,t===!1&&e&&(it=!0)}catch(t){console.error(`Webcam capture error:`,t),tt=!1,e&&Pe(t)&&(it=!0)}finally{nt=!1}jr()}}function Pr(){O&&O.setWebcam(!1).catch(()=>{}),tt&&(tt=!1,jr())}function Fr(){if(k&&k.gamepadManager){if(F)return k.gamepadManager.enable(),console.log(`Shared mode: Gamepad control message received, ensuring its GamepadManager remains active for polling.`),!0;if(ot)return k.gamepadManager.enable(),console.log(`Primary mode: Gamepad toggle ON. Enabling GamepadManager polling.`),!0;k.gamepadManager.disable(),console.log(`Primary mode: Gamepad toggle OFF. Disabling GamepadManager polling.`)}else console.warn(`Client: input.gamepadManager not found in 'gamepadControl' message handler`);return!1}function Ir(e){if(e.origin!==window.location.origin){console.warn(`Received message from unexpected origin`);return}let t=e.data;switch(t.type){case`statsOpen`:Ke.setOpen(t.open);break;case`setScaleLocally`:if(F)break;typeof t.value==`boolean`?(be=t.value,U(`scaleLocallyManual`,be),console.log(`Set scaleLocallyManual to ${be} and persisted.`),window.manualResolution&&E&&D&&ur(E,D,be)):console.warn(`Invalid value received for setScaleLocally:`,t.value);break;case`resetResolutionToWindow`:if(F)break;console.log(`Resetting to window size`),window.manualResolution=!1,D=E=0,Jt(`manual_width`,null),Jt(`manual_height`,null),U(`manual_resolution`,!1),G(`manual resolution cleared`),br(),kr(),pr();break;case`setManualResolution`:{if(F)break;if(window.enable_resize===!1&&L!==`display2`){console.log(`setManualResolution ignored: the server keeps this display's size (enable_resize=false).`);break}let e=parseInt(t.width,10),n=parseInt(t.height,10);if(isNaN(e)||e<=0||isNaN(n)||n<=0){console.error(`Received invalid width/height for setManualResolution:`,t);break}console.log(`Setting manual resolution: ${e}x${n}`),window.manualResolution=!0,E=e,D=n,Jt(`manual_width`,E),Jt(`manual_height`,D),U(`manual_resolution`,!0),K(),G(`manual resolution set`),yr(E,D),pr(),ur(E,D,be);break}case`setUseCssScaling`:if(F)break;if(typeof t.value==`boolean`){let e=Xe!==t.value;if(Xe=t.value,t.persist!==!1&&U(`useCssScaling`,Xe),console.log(`Set useCssScaling to ${Xe}${t.persist===!1?`.`:` and persisted.`}`),k&&typeof k.updateCssScaling==`function`&&k.updateCssScaling(Xe),e){if(Un(),window.manualResolution&&E!=null&&D!=null)yr(E,D),ur(E,D,be);else if(!F&&k&&(window.enable_resize!==!1||L===`display2`)){let e=k.getWindowResolution(),t=$t(e[0]),n=$t(e[1]);yr(t,n),dr(t,n)}pr()}}else console.warn(`Invalid value received for setUseCssScaling:`,t.value);break;case`settings`:console.log(`Received settings msg from dashboard:`,t.settings),Lr(t.settings);break;case`command`:if(F)break;if(!ni){console.log(`Command sending suppressed: server has command_enabled=false; not sending 'cmd,'.`);break}if(t.value!==null&&t.value!==void 0){let e=t.value;console.log(`Received 'command' message with value: "${e}"`),O.sendDataChannelMessage(`cmd,${e}`)}else console.warn(`Received invalid command from dashboard: ${t.value}`);break;case`pipelineControl`:if(t.pipeline===`microphone`&&F){console.log(`Shared mode: Microphone control blocked.`);break}if(t.pipeline===`microphone`&&O&&typeof O.setMicrophone==`function`)$e.add(`microphone`),rt=!1,Mr(!!t.enabled);else if(t.pipeline===`video`&&F){console.log(`Shared mode: Video pipelineControl blocked.`);break}else if(t.pipeline===`video`&&O){$e.add(`video`);let e=!!t.enabled;try{O.sendDataChannelMessage(e?`START_VIDEO`:`STOP_VIDEO`),A=e,window.postMessage({type:`pipelineStatusUpdate`,video:e},window.location.origin),jr()}catch(e){console.error(`Video toggle failed:`,e)}}else if(t.pipeline===`audio`){if($e.add(`audio`),!b)break;let e=!!t.enabled;if(b.muted=!e,Qe=e,O)try{O.sendDataChannelMessage(e?`START_AUDIO`:`STOP_AUDIO`)}catch(e){console.error(`Audio toggle failed:`,e)}window.postMessage({type:`pipelineStatusUpdate`,audio:e},window.location.origin),jr()}else if(t.pipeline===`webcam`){if(F){console.log(`Shared mode: Webcam control blocked.`);break}$e.add(`webcam`),it=!1,t.enabled?Nr():Pr()}break;case`gamepadControl`:{console.log(`Received gamepad control message: enabled=${t.enabled}`);let e=t.enabled;$e.add(`gamepad`),ot!==e&&(ot=e,U(`isGamepadEnabled`,ot),jr(),Fr());break}case`clipboardUpdateFromUI`:if(console.log(`Received clipboardUpdateFromUI message.`),F){console.log(`Shared mode: Clipboard write to server blocked.`);break}ci.sendExplicit(t.text);break;case`printRequest`:hr(t.url);break;case`clipboardCopySecret`:Et.copySecret();break;case`clipboardImageUpdate`:if(F){console.log(`Shared mode: Clipboard image write to server blocked.`),mi(`viewers cannot set the clipboard`,`clipboardSkipReadonly`);break}if(!t.imageBlob){mi(`no image selected`,`clipboardSkipNoImage`);break}if(!vt){mi(`image clipboard is disabled on the server (enable_binary_clipboard)`,`clipboardSkipBinaryDisabled`);break}ci.sendExplicit(t.imageBlob,t.imageBlob.type||`image/png`,mi).catch(e=>{console.warn(`Failed to send uploaded clipboard image:`,e),mi(`send failed: `+e.message,`clipboardSkipSendFailed`)});break;case`audioDeviceSelected`:t.context===`output`&&t.deviceId?(me=t.deviceId,Bn()):t.context===`input`&&t.deviceId&&(he=t.deviceId,j&&O&&typeof O.setMicrophone==`function`&&O.setMicrophone(!1).then(()=>O.setMicrophone(!0,he)).catch(e=>{console.error(`Microphone device switch failed:`,e),j=!1,jr()}));break;case`requestFullscreen`:case`requestGamingMode`:{let e=t.type===`requestGamingMode`;p=e,k&&e&&typeof k.enterGamingMode==`function`?k.enterGamingMode():k?k.enterFullscreen():document.fullscreenElement===null&&document.documentElement.requestFullscreen(e?{keyboardLock:`browser`}:void 0).catch(()=>{});break}case`setSynth`:k&&typeof k.setSynth==`function`&&k.setSynth(t.value);break;case`showVirtualKeyboard`:{if(F)break;let e=document.getElementById(`keyboard-input-assist`),t=document.getElementById(`overlayInput`);e&&(e.value=``,e.focus(),t&&t.addEventListener(`touchstart`,()=>{document.activeElement===e&&e.blur()},{once:!0,passive:!0}));break}case`setAntiAliasing`:typeof t.value==`boolean`?(ft=t.value,U(`antiAliasingEnabled`,ft),Un()):console.warn(`Invalid value received for setAntiAliasing:`,t.value);break;case`setUseBrowserCursors`:typeof t.value==`boolean`?(mt=t.value,U(`use_browser_cursors`,t.value),en()):console.warn(`Invalid value received for setUseBrowserCursors:`,t.value);break;case`setRawPointerMotion`:typeof t.value==`boolean`?(ht=t.value,U(`raw_pointer_motion`,t.value),rn()):console.warn(`Invalid value received for setRawPointerMotion:`,t.value);break;case`setTrackpadSpeed`:typeof t.value==`number`&&Number.isFinite(t.value)?(an=t.value,Zt(`trackpad_speed`,String(t.value)),sn()):console.warn(`Invalid value received for setTrackpadSpeed:`,t.value);break;case`setGamepadRumble`:typeof t.value==`boolean`?(dn=t.value,U(`gamepad_rumble`,t.value),pn()):console.warn(`Invalid value received for setGamepadRumble:`,t.value);break;case`setMacCmdAsCtrl`:typeof t.value==`boolean`?(mn=t.value,U(`mac_cmd_as_ctrl`,t.value),hn()):console.warn(`Invalid value received for setMacCmdAsCtrl:`,t.value);break;case`touchinput:trackpad`:k&&typeof k.setTrackpadMode==`function`&&(pt=!0,U(`trackpadMode`,!0),k.setTrackpadMode(!0));break;case`touchinput:touch`:k&&typeof k.setTrackpadMode==`function`&&(pt=!1,U(`trackpadMode`,!1),k.setTrackpadMode(!1))}}function Lr(e,i){let a=i?()=>{}:Jt,o=i?()=>{}:U,s=i?()=>{}:Zt;if(i||Zr(Bt,Object.keys(e)),e.webcam_encoder!==void 0){let t=String(e.webcam_encoder);rr.includes(t)&&t!==at&&(at=t,s(`webcam_encoder`,t),O&&tt&&O.setWebcamCodec(t).catch(()=>{}))}if(e.debug!==void 0){xe=e.debug,U(`debug`,xe),console.log(`Applied debug setting: ${xe}. Reloading...`),setTimeout(()=>{window.location.reload()},700);return}let c={};if(e.video_fullcolor!==void 0&&(c.video_fullcolor=!!e.video_fullcolor),e.video_10bit!==void 0&&(c.video_10bit=!!e.video_10bit),e.video_streaming_mode!==void 0&&(c.video_streaming_mode=!!e.video_streaming_mode),e.use_paint_over_quality!==void 0&&(c.use_paint_over_quality=!!e.use_paint_over_quality),e.video_paintover_crf!==void 0&&(c.video_paintover_crf=parseInt(e.video_paintover_crf,10)),e.video_paintover_burst_frames!==void 0&&(c.video_paintover_burst_frames=parseInt(e.video_paintover_burst_frames,10)),e.force_aligned_resolution!==void 0&&(c.force_aligned_resolution=!!e.force_aligned_resolution),e.use_cpu!==void 0&&(c.use_cpu=!!e.use_cpu),e.cpu_encode_threading!==void 0&&(c.cpu_encode_threading=!!e.cpu_encode_threading),e.encoder!==void 0&&(c.encoder=e.encoder),e.displayPosition!==void 0&&(c.displayPosition=e.displayPosition),e.video_bitrate!==void 0&&(n=parseInt(e.video_bitrate,10),O.sendDataChannelMessage(`vb,${n}`),a(`video_bitrate`,n),i||Me(L)),e.framerate!==void 0){let t=e.framerate===Or;s(`framerate`,t?Or:String(parseFloat(e.framerate)));let n=t?sr():parseFloat(e.framerate);Number.isFinite(n)&&(r=l=n,O.sendDataChannelMessage(`_arg_fps,${n}`))}if(e.audio_bitrate!==void 0&&(u=parseInt(e.audio_bitrate),O.sendDataChannelMessage(`ab,${u}`),a(`audio_bitrate`,u)),e.encoder!==void 0&&(ae=e.encoder,s(`encoder`,ae),console.log(`Encoder switched to:`,ae)),e.scaling_dpi!==void 0){let t=parseInt(e.scaling_dpi,10);!isNaN(t)&&t>0&&(Ze=t,pr(),Xe&&!window.manualResolution&&!F&&kr())}if(e.enable_binary_clipboard!==void 0&&(vt=!!e.enable_binary_clipboard,O.sendDataChannelMessage(`_ebc,${vt}`),o(`enable_binary_clipboard`,vt),console.log(`Binary clipboard support ${vt?`enabled`:`disabled`}`)),e.keyboard_shortcuts!==void 0&&(vn=!!e.keyboard_shortcuts,o(`keyboard_shortcuts`,vn),bn()),e.print_auto!==void 0&&yn&&(yn.setAutomatic(e.print_auto),o(`print_auto`,!!e.print_auto)),e.clipboard_seamless!==void 0&&(re=!!e.clipboard_seamless,o(`clipboard_seamless`,re)),e.clipboard_in_enabled!==void 0&&(te=!!e.clipboard_in_enabled,o(`clipboard_in_enabled`,te)),e.clipboard_out_enabled!==void 0&&(ne=!!e.clipboard_out_enabled,o(`clipboard_out_enabled`,ne)),e.use_css_scaling!==void 0&&Ir({origin:window.location.origin,data:{type:`setUseCssScaling`,value:!!e.use_css_scaling,persist:!i}}),e.use_browser_cursors!==void 0&&(mt=!!e.use_browser_cursors,en()),e.raw_pointer_motion!==void 0&&(ht=!!e.raw_pointer_motion,rn()),e.mac_cmd_as_ctrl!==void 0&&(mn=!!e.mac_cmd_as_ctrl,hn()),e.rate_control_mode!==void 0&&(oe=e.rate_control_mode,O.sendDataChannelMessage(`_rc,${oe}`),zr(oe),s(`rate_control_mode`,oe),console.log(`Rate control mode set to ${oe}`)),e.video_crf!==void 0&&(t=parseInt(e.video_crf,10),O.sendDataChannelMessage(`_crf,${t}`),a(`video_crf`,t),console.log(`Video CRF set to ${t}`)),e.force_aligned_resolution!==void 0){if(_t=!!e.force_aligned_resolution,o(`force_aligned_resolution`,_t),window.manualResolution&&E!=null&&D!=null)yr(E,D);else if(!F&&k&&(window.enable_resize!==!1||L===`display2`)){let e=k.getWindowResolution();yr(e[0],e[1])}}if(!i){let i=Object.keys(e).filter(e=>Wr.includes(e)),a={framerate:r,video_bitrate:n,audio_bitrate:u,video_crf:t,rate_control_mode:oe};for(let e of i)c[e]===void 0&&a[e]!==void 0&&(c[e]=a[e]);i.length>0&&(c.picked=i)}Object.keys(c).length>0&&O.sendDataChannelMessage(`SETTINGS,${JSON.stringify(c)}`)}function Rr(e){if(F)return;let i=Xr(Bt,I,e,`${new Date().toISOString()} the settings of a display it shares`);if(Object.keys(i).length===0)return;console.log(`[display] Streaming with what the display does:`,i);for(let[e,t]of Object.entries(i))window[e]=t;i.encoder!==void 0&&(ae=i.encoder),i.video_crf!==void 0&&(t=parseInt(i.video_crf,10)),i.video_bitrate!==void 0&&(n=parseInt(i.video_bitrate,10)),i.audio_bitrate!==void 0&&(u=parseInt(i.audio_bitrate,10)),i.rate_control_mode!==void 0&&(oe=i.rate_control_mode);let a=parseFloat(i.framerate);Number.isFinite(a)&&(r=l=a),At&&window.postMessage({type:`serverSettings`,payload:{...At}},window.location.origin)}function zr(e){e===`cbr`?O.sendDataChannelMessage(`vb,${n}`):e===`crf`&&O.sendDataChannelMessage(`_crf,${t}`)}let Br=Sn({canUpload:()=>!F}),Vr=Br.handleRequestFileUpload,Gr=Br.handleFileInputChange,Kr=Br.handleDragOver,qr=Br.handleDrop;function Jr(e){if(Ve.reading||Ve.current&&Ve.key===e)return;let t=O&&O.element,n=t&&t.srcObject&&t.srcObject.getVideoTracks()[0];if(!n||n.readyState!==`live`)return;e!==Ve.key&&(Ve={key:e,track:void 0,element:void 0,current:!1,reading:!1});try{let e=new VideoFrame(t);Ve.element=e.format,e.close()}catch{}if(typeof MediaStreamTrackProcessor!=`function`){Ve.current=Ve.element!==void 0;return}let r=n.clone(),i=new MediaStreamTrackProcessor({track:r}).readable.getReader();Ve.reading=!0,Promise.race([i.read(),new Promise(e=>setTimeout(e,2e3))]).then(t=>{let n=t&&t.value;n&&(Ve.key===e&&(Ve.track=n.format,Ve.current=!0),n.close())}).catch(()=>{}).finally(()=>{Ve.reading=!1,i.cancel().catch(()=>{}),r.stop()})}function ii(e){let t=e.reports.videoRTP||{},n=e.reports.candidatePairs[e.reports.selectedCandidatePairId]||{},r=e.reports.localCandidates[n.localCandidateId]||{},i=e.reports.remoteCandidates[n.remoteCandidateId]||{},a=e.video.codecName===`NA`?``:e.video.codecName,o=e.video.frameWidth,s=e.video.frameHeight,c=((e.reports.codecs[t.codecId]||{}).sdpFmtpLine||``).replace(/\s/g,``),l=`video/${a}${c?`;${c}`:``}`,u=`${l}:${o}x${s}`;if(a&&o>0){let t=e.video.framesPerSecond;Be.ask({type:`webrtc`,video:{contentType:l,width:o,height:s,bitrate:8e6,framerate:t>0?t:60}},u),Jr(u)}let d=Ve.key===u?Ve:{},f=r.candidateType===`relay`||i.candidateType===`relay`?`relay`:i.candidateType;Ke.setClient(Object.assign({sink:`<video> element`,codec:a,resolution:o>0?`${o}x${s}`:``,path:f?`${f} ${r.relayProtocol||r.protocol||``}`.trim():``},wr({implementation:t.decoderImplementation,powerEfficient:t.powerEfficientDecoder,trackFormat:d.track,elementFormat:d.element,capable:Be.efficient})))}function ai(e,t,n){let r=e.reports.videoRTP||{},i=e.reports.audioRTP||{},a={at:performance.now(),bytes:(r.bytesReceived||0)+(i.bytesReceived||0),framesDecoded:r.framesDecoded||0,totalDecodeTime:r.totalDecodeTime||0,jitterBufferDelay:r.jitterBufferDelay||0,jitterBufferEmittedCount:r.jitterBufferEmittedCount||0,audioJitterBufferDelay:i.jitterBufferDelay||0,audioJitterBufferEmittedCount:i.jitterBufferEmittedCount||0,micBytes:(e.reports.outbound.audio||{}).bytesSent||0,webcamBytes:(e.reports.outbound.video||{}).bytesSent||0},o={framesDropped:r.framesDropped||0,nack:r.nackCount||0,pli:r.pliCount||0,freezes:r.freezeCount||0,received:(r.packetsReceived||0)+(i.packetsReceived||0),lost:(r.packetsLost||0)+(i.packetsLost||0)},s=ze,c=!!s&&s.pc!==n,l=s?c?Object.fromEntries(Object.keys(o).map(e=>[e,s.opened[e]-s.counts[e]])):s.opened:o;if(ze=Object.assign({pc:n,counts:o,opened:l},a),!s){!We&&b&&(Ue.reset(),Ge=0,We=Dr(b,Ue,e=>typeof e.receiveTime==`number`?e.presentationTime-e.receiveTime:NaN));return}if(Ke.noteBytes(c?a.bytes:Math.max(0,a.bytes-s.bytes)),c){Ue.take(),We&&(Ge+=We.read().dropped);return}let u=(a.at-s.at)/1e3,d=(e,t)=>t>0?Math.round(1e3*e/t*100)/100:0,f=(e,t)=>t>0?Math.round(100*e/t*100)/100:0,p=e=>u>0?Math.round(e*8/1e3/u):0,m=o.lost-l.lost,h=Ue.take(),g=We?We.read():{shown:0,dropped:0};Ge+=g.dropped;let _={fps:We&&We.reported()&&u>0?Math.round(g.shown/u*10)/10:e.video.framesPerSecond||0,rtt_ms:Math.round(t*10)/10,decode_ms:d(a.totalDecodeTime-s.totalDecodeTime,a.framesDecoded-s.framesDecoded),jitter_buffer_ms:d(a.jitterBufferDelay-s.jitterBufferDelay,a.jitterBufferEmittedCount-s.jitterBufferEmittedCount),audio_buffer_ms:d(a.audioJitterBufferDelay-s.audioJitterBufferDelay,a.audioJitterBufferEmittedCount-s.audioJitterBufferEmittedCount),packet_loss_percent:f(m,o.received-l.received+m),frames_dropped:o.framesDropped-l.framesDropped,frames_not_shown:Ge,nacks:o.nack-l.nack,keyframe_requests:o.pli-l.pli,freezes:o.freezes-l.freezes};h.delays>0&&(_.present_ms=Math.round(h.delaySum/h.delays*100)/100),e.reports.outbound.audio&&a.micBytes>s.micBytes&&(_.mic=`Opus, ${p(a.micBytes-s.micBytes)} kbps`);let ee=e.reports.outbound.video;if(ee&&a.webcamBytes>s.webcamBytes){let e=ee.qualityLimitationReason&&ee.qualityLimitationReason!==`none`?`, limited by ${ee.qualityLimitationReason}`:``;_.webcam=`${ee.frameWidth||0}x${ee.frameHeight||0} at ${Math.round(ee.framesPerSecond||0)} fps, ${p(a.webcamBytes-s.webcamBytes)} kbps${e}`}Ke.clientSample(_)}function oi(){if(F){console.log(`Shared mode detected, skipping stats watch setup.`);return}var e=0,t=0,n=0,r=0,i=0,a=0,o=new Date().getTime()/1e3;if(Je!==null)return;Ie=!0;let s=!1,c=async()=>{if(qe=null,s)return;s=!0;let l=!1;var u=new Date().getTime()/1e3;try{let s=O.peerConnection,c=await O.getConnectionStats();y={};let d=c.general.currentRoundTripTime===null?_e:c.general.currentRoundTripTime*1e3;y.connectionPacketsReceived=c.general.packetsReceived,y.connectionPacketsLost=c.general.packetsLost,y.connectionStatType=c.general.connectionType,y.connectionBytesReceived=(c.general.bytesReceived*1e-6).toFixed(2)+` MBytes`,y.connectionBytesSent=(c.general.bytesSent*1e-6).toFixed(2)+` MBytes`,y.connectionAvailableBandwidth=(parseInt(c.general.availableReceiveBandwidth)/1e6).toFixed(2)+` mbps`,y.connectionCodec=c.video.codecName,y.connectionVideoDecoder=c.video.decoder,y.connectionResolution=c.video.frameWidth+`x`+c.video.frameHeight,y.connectionFrameRate=c.video.framesPerSecond,y.connectionVideoBitrate=((c.video.bytesReceived-e)/(u-o)*8/1e6).toFixed(2),e=c.video.bytesReceived,y.connectionAudioCodecName=c.audio.codecName,y.connectionAudioBitrate=((c.audio.bytesReceived-t)/(u-o)*8/1e3).toFixed(2),t=c.audio.bytesReceived,y.connectionAudioConcealedSamples=c.audio.concealedSamples,y.connectionAudioConcealmentEvents=c.audio.concealmentEvents,y.connectionAudioTotalSamplesReceived=c.audio.totalSamplesReceived,y.connectionAudioPacketsDiscarded=c.audio.packetsDiscarded,o=u,y.connectionVideoLatency=parseInt(Math.round(d+(1e3*(c.video.jitterBufferDelay-n)/(c.video.jitterBufferEmittedCount-r)||0))),n=c.video.jitterBufferDelay,r=c.video.jitterBufferEmittedCount,y.connectionAudioLatency=parseInt(Math.round(d+(1e3*(c.audio.jitterBufferDelay-i)/(c.audio.jitterBufferEmittedCount-a)||0)));let f=1e3*(c.audio.jitterBufferDelay-i)/(c.audio.jitterBufferEmittedCount-a)||0;window.currentAudioBufferSize=Math.max(0,Math.round(f/20)),i=c.audio.jitterBufferDelay,a=c.audio.jitterBufferEmittedCount,y.connectionLatency=Math.max(y.connectionVideoLatency,y.connectionAudioLatency),window.fps=y.connectionFrameRate,ii(c),Ke.open&&(l=ze===null,ai(c,d,s)),Ne&&O.sendDataChannelMessage(`_stats_video,${JSON.stringify(c.allReports)}`)}catch(e){O!==null&&console.warn(`Error collecting connection stats:`,e)}finally{if(s=!1,Je===c&&qe===null){let e=Ne?1e3:5e3;Ke.open&&(e=ze===null?0:l?500:1e3),qe=setTimeout(c,e)}}};Je=c,qe=setTimeout(c,1e3)}function si(){Je!==null&&(qe!==null&&(clearTimeout(qe),qe=null),Je())}let ci=tn({isChromium:wt,getDeferredWriteInFlight:()=>P.getInFlight(),isSharedMode:()=>F,canSync:()=>ee===`enabled`&&!!window.clipboard_enabled&&re,canRead:()=>!!te,binaryEnabled:()=>!!vt,sendClipboardData:(e,t,n)=>gi(e,t,n),clipboardSync:Tt}),li=()=>ci.readAndSend(),ui=()=>ci.maybeInitial(),di=un({isChromium:wt,clipboardSync:Tt,sendClipboardData:(e,t)=>gi(e,t),canSync:()=>!F&&ee===`enabled`&&!!window.clipboard_enabled&&re,canRead:()=>!!te,canWrite:()=>!!ne,binaryEnabled:()=>!!vt,getSendInFlight:()=>ci.getSendInFlight(),getDeferredWriteLanding:()=>P.getLanding(),hasPendingServerWrite:()=>P.hasPending(),readLocalClipboard:li});async function fi(){O.sendDataChannelMessage(`kr`),wt&&li()}function pi(){O.sendDataChannelMessage(`kr`)}function mi(e,t){console.warn(`Clipboard image upload skipped: `+e),window.postMessage({type:`fileUpload`,payload:{status:`warning`,fileName:`clipboard-image`,message:e,code:t}},window.location.origin)}function hi(e){let t=Kt()||e&&e.message||String(e);console.error(`Failed to write the session image to the local clipboard:`,e),window.postMessage({type:`fileUpload`,payload:{status:`warning`,fileName:`clipboard-image`,message:t,code:`clipboardImageWriteFailed`}},window.location.origin)}async function gi(e,t=`text/plain`,n=null){let r=(e,t)=>{n&&n(e,t)};if(e==null){r(`nothing to send`,`clipboardSkipNoImage`);return}if(ee!==`enabled`||window.clipboard_enabled===void 0){r(`the session has not reported its clipboard policy yet`,`clipboardSkipNotConnected`);return}if(!window.clipboard_enabled){r(`the server has the clipboard turned off`,`clipboardSkipDisabled`);return}if(!te){r(`the client-to-session clipboard is turned off`,`clipboardSkipInDisabled`);return}if(!O||!O.dataChannelOpen()){r(`not connected`,`clipboardSkipNotConnected`);return}let i=e instanceof ArrayBuffer||e instanceof Uint8Array,a;i?a=e instanceof Uint8Array?e:new Uint8Array(e):(a=new TextEncoder().encode(e),t=`text/plain`);let o=e;if(i)try{let{byteLength:e,hash:t}=await yt.hashBytes(a.slice().buffer);o=Wt(e,t)}catch{}if(!Tt.shouldSend(o,t)){r(`already the current clipboard`,`clipboardSkipUnchanged`);return}try{if(await kn(a,t,{worker:yt,send:e=>O.sendDataChannelMessage(e),waitDrain:async()=>(O.waitForDataChannelDrain&&await O.waitForDataChannelDrain(65536),!0),chunkRawBytes:Math.min(16383,Math.max(1,Math.floor(M()*3/4))),nextTid:()=>++ti}),!O.dataChannelOpen()){r(`connection lost during send`,`clipboardSkipSendFailed`);return}Tt.markSynced(o,t)}catch(e){console.error(`Error sending clipboard data:`,e),r(`send failed: `+(e&&e.message?e.message:e),`clipboardSkipSendFailed`)}}return{initialize(){ri();let i=document.getElementById(`app`),o=document.createElement(`div`);o.className=`video-container`,Te=document.createElement(`button`),Te.id=`playButton`,Te.textContent=`Play Stream`,Te.classList.add(`hidden`),Te.addEventListener(`click`,Tn),S=document.createElement(`div`),S.id=`status-display`,S.className=`status-bar`,S.textContent=`Connecting...`;let l=document.createElement(`input`);l.type=`search`,l.readOnly=!1,l.autocomplete=`off`,l.inputMode=`none`,l.virtualKeyboardPolicy=`manual`,l.setAttribute(`autocorrect`,`off`),l.setAttribute(`autocapitalize`,`off`),l.setAttribute(`spellcheck`,`false`),l.id=`overlayInput`,b=document.createElement(`video`),b.id=`stream`,b.className=`video`,b.autoplay=!0,b.playsInline=!0,b.addEventListener(`resize`,()=>{let e=b.videoWidth,t=b.videoHeight;e>0&&t>0&&fe&&(window.streamResolutionDiverged=e!==fe[0]||t!==fe[1]),F||Un(),$r&&!F&&It>0&&Math.abs(or()-It)>1e-6&&lr()});let pe=document.createElement(`input`);if(pe.type=`file`,pe.id=`globalFileInput`,pe.multiple=!0,pe.style.display=`none`,document.body.appendChild(pe),pe.addEventListener(`change`,Gr),o.appendChild(b),o.appendChild(Te),o.appendChild(S),o.appendChild(l),i.appendChild(o),!document.getElementById(`keyboard-input-assist`)){let e=document.createElement(`input`);e.type=`search`,e.id=`keyboard-input-assist`,e.style.position=`absolute`,e.style.left=`-9999px`,e.style.top=`-9999px`,e.style.width=`1px`,e.style.height=`1px`,e.style.opacity=`0`,e.style.border=`0`,e.style.padding=`0`,e.style.caretColor=`transparent`,e.setAttribute(`aria-hidden`,`true`),e.setAttribute(`autocomplete`,`off`),e.setAttribute(`autocorrect`,`off`),e.setAttribute(`autocapitalize`,`off`),e.setAttribute(`spellcheck`,`false`),document.body.appendChild(e),console.log(`Dynamically added #keyboard-input-assist element.`)}e=`webrtc`,xe=H(`debug`,!1),Se=H(`turn_switch`,!1),ye=H(`resize_remote`,ye),be=H(`scaleLocallyManual`,!ye),n=V(`video_bitrate`,n),r=qt(`framerate`,r),u=V(`audio_bitrate`,u),!F&&!c&&(window.displayRefreshRate=null,c=Ur(e=>{window.displayRefreshRate=e,window.postMessage({type:`displayRefresh`,rate:e},window.location.origin),cr()})),window.manualResolution=H(`manual_resolution`,!1),ot=H(`isGamepadEnabled`,!0),E=V(`manual_width`,null),D=V(`manual_height`,null),ae=Yt(`encoder`,`h264enc`),oe=Yt(`rate_control_mode`,`cbr`),Xe=H(`useCssScaling`,!1),Ze=Yt(`scaling_dpi`,null)===null?fr():V(`scaling_dpi`,96),vt=H(`enable_binary_clipboard`,vt),te=H(`clipboard_in_enabled`,te),ne=H(`clipboard_out_enabled`,ne),re=H(`clipboard_seamless`,re),vn=H(`keyboard_shortcuts`,vn),yn=gr({automatic:H(`print_auto`,!0)}),t=V(`video_crf`,t),ft=H(`antiAliasingEnabled`,!0),pt=H(`trackpadMode`,!1),mt=H(`use_browser_cursors`,!0),ht=H(`raw_pointer_motion`,Ft.rawPointerMotion),an=qt(`trackpad_speed`,1),dn=H(`gamepad_rumble`,!0),_t=H(`force_aligned_resolution`,!1),F||(window.addEventListener(`message`,Ir),window.addEventListener(`requestFileUpload`,Vr),l.addEventListener(`dragover`,Kr),l.addEventListener(`drop`,qr)),document.addEventListener(`visibilitychange`,Ln);let me=Dt.startsWith(`#display2`)?`display2`:`primary`,he=`right`;if(me===`display2`){let e=Dt.match(/^#display2-(right|left|up|down)/);e&&(he=e[1])}Mt=null;var ge=Ee()+`/`,ve=location.protocol==`http:`?`ws://`:`wss://`,we=new URL(ve+window.location.host+ge+`api/`+e+`/signaling/`),ke=gn()||void 0;x=!1;let Ae=null;var C=new He(we,ut,dt,Ot,ke,me,he);C.capabilities=async()=>{let e=[];for(let t of[`h264`,`h265`,`vp9`])await qn(t)&&e.push(t);return e},C.pageSize=()=>{if(F||window.manualResolution||L===`display2`||!k)return null;let[e,t]=vr(...k.getWindowResolution());return[e,t]},C.tenBitCapabilities=async()=>{let e=[];for(let t of[`h264`,`h265`,`vp9`,`av1`])for(let n of[!1,!0])(!n||a(t))&&await er(t,n)&&e.push(Ce(t,n));return e},C.onfatalretry=async()=>{let e=new URL(we.href);e.protocol=location.protocol===`http:`?`http:`:`https:`;let t=await De(e.href,_n());if(!t){C.retry();return}let n=null;try{n=sessionStorage.getItem(`selkies_mode_flip`)}catch{}if(!n&&t.status===409){try{sessionStorage.setItem(`selkies_mode_flip`,`1`)}catch{}Zt(`stream_mode`,`websockets`),console.warn(`[signaling] Server is serving WebSockets (endpoint 409); switching stored mode.`)}location.reload()},O=new Re(C,b,1),ei=O,k=new Ft(l,e=>{F&&Ot&&!kt||O.sendDataChannelMessage(e)},F,lt,Xe),k.displayId=me,k.setFingerScroll(R),k.sendMotion=e=>{F&&Ot&&!kt||O.sendMotionMessage(e)},k.motionBacklog=()=>O.motionBufferedAmount(),k.setShortcutsEnabled(vn),k.setDisplayLayouts(Mt,me),k.ongamepadconnected=e=>{Fr()&&(v.gamepadState=`connected`,v.gamepadName=e,O._setStatus(`Gamepad connected: `+e))},k.ongamepaddisconnected=()=>{v.gamepadState=`disconnected`,v.gamepadName=`none`,O._setStatus(`Gamepad disconnected`)},F||(window.addEventListener(`focus`,fi),window.addEventListener(`blur`,pi),di.wire()),k.attach(),k.getWindowResolution=()=>{let e=b&&b.parentElement;if(!e)return[window.innerWidth,window.innerHeight];let t=e.getBoundingClientRect();return[t.width,t.height]},window.webrtcInput=k,pt&&k.setTrackpadMode(!0),en(),rn(),hn(),sn(),pn(),window.postMessage({type:`trackpadModeUpdate`,enabled:pt},window.location.origin),window.postMessage({type:`clientRoleUpdate`,role:ut},window.location.origin),C.onstatus=e=>{m(h,Qt(`[signaling] `+e)),console.log(`[signaling] `+e)},C.onerror=e=>{m(h,Qt(`[signaling] [ERROR] `+e)),console.log(`[signaling ERROR] `+e)},C.ondisconnect=e=>{Ae!==null&&(clearTimeout(Ae),Ae=null),b.style.cursor=`auto`,Et.reset(),On(),k&&k.stopRumble(),window.__selkiesAuthProbe&&window.__selkiesAuthProbe(),e?(_=`connecting`,$e.clear(),et=!1,A=!0,Qe=!0,b.muted=!1,O.reset()):_=`disconnected`,Hn()},C.resumable=()=>!x&&!window.__selkiesModeSwitching&&!!O.peerConnection&&O.peerConnection.connectionState===`connected`,C.onresumed=()=>{O.peerConnection.connectionState!==`connected`&&C.reconnect()},C.onshowalert=e=>{x=!0,alert(`Disconnected: `+e+` Please try again.`)},O.onstatus=e=>{m(h,Qt(`[webrtc] `+e)),console.log(`[webrtc] `+e)},O.onerror=e=>{m(h,Qt(`[webrtc] [ERROR] `+e)),console.log(`[webrtc] [ERROR] `+e)},xe&&(C.ondebug=e=>{m(g,`[signaling] `+e)},O.ondebug=e=>{m(g,Qt(`[webrtc] `+e))}),O.onstreaminfo=e=>Ke.setInfo(e),O.onstreamstats=e=>Ke.serverSample(e),O.onconnection=e=>Ke.setConnection(e),O.onconnectionstatechange=e=>{if(Fe=e,Fe===`connected`){_=e,le=0,ue=!0,de&&(de=!1,window.postMessage({type:`transportAdvice`,offer:null},window.location.origin));try{sessionStorage.removeItem(`selkies_mode_flip`)}catch{}Oe(_n()).then(e=>{e!==null&&(ce===null?ce=e:e!==ce&&location.reload())}),Ae!==null&&(clearTimeout(Ae),Ae=null),Ie||oi(),Dn(),Bn(),Fn()}else(e===`failed`||e===`disconnected`)&&(k&&k.stopRumble(),e===`failed`&&!x&&C.state===`connected`&&!window.__selkiesModeSwitching&&(le++,!de&&le>=(ue?2:1)&&(de=!0,console.warn(`[webrtc] ${le} session(s) failed with signaling up; offering WebSockets.`),window.postMessage({type:`transportAdvice`,offer:`websockets`},window.location.origin))),!x&&Ae===null&&(Ae=setTimeout(()=>{Ae=null;let e=O.peerConnection&&O.peerConnection.connectionState;e===`connected`||x||typeof window<`u`&&window.__selkiesModeSwitching||C.state===`connected`&&(console.warn(`[webrtc] connection ${e}; reconnecting in place.`),C.reconnect())},e===`failed`?400:8e3)));Hn()},O.ondatachannelopen=()=>{console.log(`Data channel opened`),Ke.subscribe();try{bt.armLegacyWindow(5e3),O.sendDataChannelMessage(`cr`)}catch(e){console.warn(`Failed to send initial clipboard request (cr):`,e)}if(k&&k.resyncGamepads(),F){console.log(`Shared mode: skipping loading of last session settings and sending persisted settings to server`);return}Ar(),Kn().then(nr).then(lr),Ye!==null&&clearInterval(Ye),Ye=setInterval(async()=>{y.connectionFrameRate===parseInt(y.connectionFrameRate,10)&&O.sendDataChannelMessage(`_f,${y.connectionFrameRate}`),y.connectionLatency===parseInt(y.connectionLatency,10)&&O.sendDataChannelMessage(`_l,${y.connectionLatency}`)},5e3)},k.onmenuhotkey=()=>{f=!f,window.postMessage({type:`toggleDashboard`},window.location.origin)},k.ongamepadhotkey=()=>{window.postMessage({type:`toggleTouchGamepad`},window.location.origin)},k.gamingMode=p,k.ongamingmode=e=>{p=e,window.postMessage({type:`gamingModeUpdate`,active:e},window.location.origin)},k.onnotice=(e,t)=>{window.postMessage({type:`fileUpload`,payload:{status:`warning`,fileName:e,message:t,code:e}},window.location.origin)},O.onplaystreamrequired=()=>{d=!0},O.onclipboardcontent=e=>{if(!e.data){console.warn(`Received clipboard message with null data`);return}if(e.data.reply_to===`cr`&&xt(),!F)switch(e.type){case`clipboard-msg`:Et.single(e.data.mime_type||`text/plain`,e.data.content,St(),e.data.secret===!0);break;case`clipboard-msg-start`:Et.begin(e.data.mime_type,e.data.total_size,St(),e.data.secret===!0);break;case`clipboard-msg-data`:Et.push(e.data.content);break;case`clipboard-msg-end`:Et.finish();break;default:console.warn(`Unknown clipboard cmd received`)}},O.oncursorchange=e=>{k.updateServerCursor(e)},O.ondisplayconfig=e=>{let t=e&&e.displays||[];Mt=e&&e.layouts||null,Nt=!!(e&&e.wayland),R=!!(e&&e.finger_scroll),k&&k.setFingerScroll&&k.setFingerScroll(R),k&&k.setDisplayLayouts&&k.setDisplayLayouts(Mt,me),Rt();let n=t.some(e=>e!==`primary`);gt!==n&&(console.log(`Secondary display connection status changed to: ${n}`),gt=n,en())},O.onccrate=e=>je(L,e),O.onprintdocument=e=>{yn&&!fn().startsWith(`#display2`)&&yn.announce(e.name,e.size_bytes)},O.onsystemaction=e=>{if(e.startsWith(`rumble,`)){let[t,n,r,i]=e.split(`,`).slice(1).map(Number);k&&k.rumble(t,n,r,i);return}if(e.startsWith(`pointer,`)){k&&k.onPointerEcho(e);return}if(e.startsWith(`video_declined,`)){let t=e.slice(15).split(`/`).pop().toLowerCase();Vn=!0,console.error(`This session streams ${t}, which this browser cannot decode.`),S&&(S.textContent=`Error: This session streams ${se(t)} video, which this browser cannot decode.`,S.classList.remove(`hidden`));return}if(O._setStatus(`Executing system action: `+e),e===`reload`)setTimeout(()=>{C.disconnect()},700);else if(e.startsWith(`mk_access,`)){let t=e.slice(10)===`1`;kt=t,k&&(t?k.isInputAttached()||(console.log(`Collab access granted: attaching input context.`),k.attach_context()):(console.log(`Collab access revoked: detaching input context.`),k.detach_context()))}else if(e.startsWith(`command_error,`)&&!F)window.postMessage({type:`fileUpload`,payload:{status:`warning`,fileName:`command`,message:e.slice(14),code:`commandFailed`}},window.location.origin);else if(e.startsWith(`command_done,`)&&!F)window.postMessage({type:`commandDone`,command:e.slice(13)},window.location.origin);else if(e.startsWith(`apps_installed,`)&&!F)window.postMessage({type:`appsInstalled`,apps:JSON.parse(e.slice(15))},window.location.origin);else if(e.startsWith(`auth_success,`)||e.startsWith(`role_update,`)){let t=e.slice(e.indexOf(`,`)+1),n;try{n=JSON.parse(t)}catch(e){console.error(`Failed to parse role verdict:`,e);return}let r=e.startsWith(`role_update,`),i=dt;ut=n.role===st?st:ct,dt=n.slot===null||n.slot===void 0?null:n.slot;let a=Array.isArray(dt)?dt[0]:dt;lt=a!==null&&a>0?a-1:void 0,console.log(`Server role verdict: role=${ut}, slot=${dt}`),k&&(k.updateControllerSlot(dt),ut===ct&&k.setSharedMode(!0),r&&k.gamepadManager&&(i!==null&&dt===null?k.gamepadManager.disable():i===null&&dt!==null&&ot&&k.gamepadManager.enable())),window.postMessage({type:`clientRoleUpdate`,role:ut},window.location.origin)}else if(e.startsWith(`capture_demand,`)&&!F){let[t,n]=e.slice(15).split(`,`);t===`webcam`&&!$e.has(`webcam`)?n===`1`?it||Nr(!0):Pr():t===`microphone`&&!$e.has(`microphone`)&&O&&typeof O.setMicrophone==`function`&&(n===`1`?rt||Mr(!0,!0):Mr(!1))}else if(e.startsWith(`resolution,`)){let t=e.slice(11).split(`x`),n=parseInt(t[0],10),r=parseInt(t[1],10);n>0&&r>0&&window.manualResolution&&(E!==n||D!==r)&&(E=n,D=r,Jt(`manual_width`,n),Jt(`manual_height`,r),ur(E,D,be))}else O._setStatus(`Server sent acknowledgment for `+e)},O.onlatencymeasurement=e=>{_e=e*2};let w=e=>{if(F||me!==`primary`)return;let t=t=>e&&e[t]||null,n=(e,n)=>{let r=t(e);return r&&typeof r.value==`boolean`?r.value:n},r=e=>{let n=t(e);return!!(n&&n.value===!1&&n.locked)},i=e=>!$e.has(e),a=!1;i(`video`)&&!n(`video_on_start`,!0)&&A&&(A=!1,window.postMessage({type:`pipelineStatusUpdate`,video:!1},window.location.origin),a=!0);let o=n(`audio_enabled`,!0)===!1;i(`audio`)&&!n(`audio_on_start`,!0)&&!o&&Qe&&(Qe=!1,b&&(b.muted=!0),window.postMessage({type:`pipelineStatusUpdate`,audio:!1},window.location.origin),a=!0),i(`microphone`)&&!n(`microphone_on_demand`,!1)&&n(`microphone_on_start`,!1)&&!r(`microphone_enabled`)&&!j&&O&&typeof O.setMicrophone==`function`&&Mr(!0),i(`webcam`)&&!n(`webcam_on_demand`,!1)&&n(`webcam_on_start`,!1)&&!r(`webcam_enabled`)&&Nr();let s=window.localStorage.getItem(Bt(`isGamepadEnabled`))!==null;if(i(`gamepad`)&&!s){let e=n(`gamepad_on_start`,!0);ot!==e&&(ot=e,Fr(),a=!0)}a&&jr()};O.ondisplaysettings=e=>Rr(e&&e.settings||{}),O.onserversettings=e=>{if(e.settings===void 0||e.settings===null){console.warn(`Received invalid server settings paylod`);return}console.log(`Received server settings payload:`,e.settings),At=e.settings;let r=Wn(e.settings);Number.isFinite(window.video_crf)&&(t=Math.round(window.video_crf)),Number.isFinite(window.video_bitrate)&&(n=Math.round(window.video_bitrate));let i=e.settings.framerate;s=i&&i.min!==void 0?{min:i.min,max:i.max}:null,cr();let a=e.settings&&e.settings.video_fullcolor;Jn=!!(a&&a.locked),a&&Yn();let o=e.settings&&e.settings.video_10bit;ir=!!(o&&o.locked),o&&ar();let c=e.settings&&e.settings.webcam_encoder;if(c&&rr.includes(c.value)){let e=Yt(`webcam_encoder`,c.value);at=c.locked||!rr.includes(e)?c.value:e,O&&tt&&O.setWebcamCodec(at).catch(()=>{})}let l=e.settings&&e.settings.command_enabled;ni=l&&typeof l.value==`boolean`?l.value:!0,et||(et=!0,w(e.settings));let u=e.settings&&e.settings.enable_resize;u&&typeof u.value==`boolean`&&(window.enable_resize=u.value);let d=e.settings&&e.settings.clipboard_in_enabled;d&&typeof d.value==`boolean`&&(te=d.value);let f=e.settings&&e.settings.clipboard_out_enabled;f&&typeof f.value==`boolean`&&(ne=f.value);let p=e.settings&&e.settings.enable_binary_clipboard;p&&typeof p.value==`boolean`&&(vt=p.locked?p.value:H(`enable_binary_clipboard`,p.value));let m=xn(e.settings);m!==ht&&(ht=m,rn());let h=Cn(e.settings);h!==mn&&(mn=h,hn());let g=wn(e.settings);if(g!==Xe&&window.postMessage({type:`setUseCssScaling`,value:g},window.location.origin),ui(),Le(e.settings),window.postMessage({type:`serverSettings`,payload:e.settings},window.location.origin),Object.keys(r).length>0&&(console.log(`Client settings were sanitized by server rules. Sending updates back to server:`,r),Lr(r,!0)),e.settings.manual_resolution&&e.settings.manual_resolution.value===!0){console.log(`Server settings payload confirms manual mode. Switching to manual resize handlers.`);let t=e.settings.manual_width?parseInt(e.settings.manual_width.value,10):0,n=e.settings.manual_height?parseInt(e.settings.manual_height.value,10):0;t>0&&n>0?(console.log(`Applying server-enforced manual resolution: ${t}x${n}`),window.manualResolution=!0,E=t,D=n,ur(E,D,be),G(`server resolution`)&&pr()):console.warn(`Server dictated manual mode but did not provide valid dimensions.`),K()}else{if(F){console.log(`Shared mode detected, skipping auto resize enablement.`);return}console.log(`Server settings payload confirms auto mode. Switching to auto resize handlers.`),br()}e.settings.enable_webrtc_statistics&&e.settings.enable_webrtc_statistics.value===!0&&(Ne=!0)},window.isSecureContext&&navigator.clipboard&&(ee=`enabled`);let T=e=>{O.forceTurn=Se,ie=k.getWindowResolution(),C.currRes=ie,be===!1&&(O.element.style.width=ie[0]+`px`,O.element.style.height=ie[1]+`px`),e.iceServers&&e.iceServers.length>1?m(g,Qt(`using TURN servers: `+e.iceServers[1].urls.join(`, `))):m(g,Qt(`no TURN servers found.`)),O.rtcPeerConfig=e,O.connect()};fetch(Ee()+`/api/turn`,{headers:_n()}).then(function(e){if(!e.ok)throw Error(`Status: ${e.status}`);return e.json()}).then(e=>{T(e)}).catch(e=>{m(g,Qt(`TURN config unavailable (${e}); connecting without TURN.`)),console.warn(`Failed to fetch TURN server details (${e}); continuing without TURN.`),T({iceServers:[]})})},cleanup(){window.manualResolution=!1,window.fps=0,Pr(),window.removeEventListener(`message`,Ir),window.removeEventListener(`resize`,xr),window.removeEventListener(`requestFileUpload`,Vr),window.removeEventListener(`focus`,fi),window.removeEventListener(`blur`,pi),document.removeEventListener(`visibilitychange`,Ln),On(),me=null,di.unwire();try{yt.terminate()}catch(e){if(e.name===`AbortError`)return;console.error(e)}yt=null,e=null,n=8e3,r=60,c&&c.stop(),c=s=l=null,u=128e3,d=!1,f=!1,h=[],g=[],_=`connecting`,ee=`disabled`,ie=[],ae=``,v={gamepadState:`disconnected`,gamepadName:`none`},y={connectionStatType:`unknown`,connectionLatency:0,connectionVideoLatency:0,connectionAudioLatency:0,connectionAudioCodecName:`NA`,connectionAudioBitrate:0,connectionPacketsReceived:0,connectionPacketsLost:0,connectionBytesReceived:0,connectionBytesSent:0,connectionCodec:`unknown`,connectionVideoDecoder:`unknown`,connectionResolution:``,connectionFrameRate:0,connectionVideoBitrate:0,connectionAvailableBandwidth:0},_e=0,ye=!1,be=!1,xe=!1,Se=!1,Te=null,S=null,C=null,w=500,T=!1,E=0,D=0,ot=!0,$e.clear(),et=!1,Fe=``,Ie=!1,Ke.disconnected(),ze=null,Je=null,qe!==null&&(clearTimeout(qe),qe=null),Ye!==null&&(clearInterval(Ye),Ye=null),Pn(),O=null,ei=null,k=null,Xe=!1,N=null,lt=0,Ne=!1,vt=!0,ni=!0,Et.reset()}}}var ai=`/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * What the video wire says about its codec, and the WebCodecs codec string a
 * stream's own key frame declares.
 *
 * A \`0x04\` frame's type byte carries the frame kind in its low nibble (\`1\` = a
 * decode entry point) and the codec id in its high nibble. The codec string a
 * \`VideoDecoder\` is configured with is read from the key frame's parameter sets
 * wherever the codec has them (the H.264 SPS, the H.265 SPS, the AV1 sequence
 * header), so it always matches the bitstream; VP8 has one string, and VP9's
 * level, which its bitstream never carries, is derived from the geometry.
 *
 * Every function here is also injected into the video worker by \`toString()\`,
 * so they reference nothing but each other and stay free of module state.
 */

/** Codec names by wire id. */
export const WIRE_CODECS = { 1: 'h264', 2: 'vp8', 3: 'vp9', 4: 'av1', 5: 'h265' };

/** Encoder wire values and the codec each streams. */
export const ENCODER_CODECS = {
  jpeg: 'jpeg',
  h264enc: 'h264',
  'h264enc-striped': 'h264',
  h265enc: 'h265',
  vp8enc: 'vp8',
  vp9enc: 'vp9',
  av1enc: 'av1',
};

/**
 * @param {number} typeByte The second byte of a video frame's wire header.
 * @returns {string} The codec name; an id no codec has reads as H.264.
 */
export const wireCodecName = (typeByte) => WIRE_CODECS[typeByte >> 4] || 'h264';

/**
 * @param {number} typeByte The second byte of a video frame's wire header.
 * @returns {boolean} Whether the frame is a decode entry point.
 */
export const wireFrameIsKey = (typeByte) => (typeByte & 0x0f) === 0x01;

/**
 * @param {string} encoder An encoder wire value.
 * @returns {string} The codec it streams; an unknown encoder reads as H.264.
 */
export const codecOfEncoder = (encoder) => ENCODER_CODECS[encoder] || 'h264';

/**
 * @param {string} codec A codec name.
 * @returns {boolean} Whether the codec can carry 4:4:4 chroma.
 */
export const codecCarriesFullColor = (codec) => codec === 'h264' || codec === 'h265' || codec === 'vp9';

/**
 * Whether a codec has a 10-bit profile the server's encoders emit (H.264 High 10
 * and High 4:4:4 Predictive, H.265 Main 10 and Main 4:4:4 10, VP9 profiles 2
 * and 3, AV1).
 * @param {string} codec The codec name.
 * @returns {boolean}
 */
export const codecCarriesTenBit = (codec) => codec === 'h264' || codec === 'h265' || codec === 'vp9' || codec === 'av1';

/**
 * The NAL units of an Annex-B buffer, each without its start code.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array[]}
 */
export const annexbNals = (bytes) => {
  const nals = [];
  const n = bytes.length;
  let start = -1;
  for (let i = 0; i + 2 < n; i++) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        while (end > start && bytes[end - 1] === 0) end--;
        if (end > start) nals.push(bytes.subarray(start, end));
      }
      start = i + 3;
      i += 2;
    }
  }
  if (start >= 0 && start < n) nals.push(bytes.subarray(start, n));
  return nals;
};

/**
 * A bit reader over an RBSP: \`bytes\` from \`offset\` with emulation prevention
 * bytes removed, \`limit\` bytes at most; \`raw\` reads them as they stand, for
 * AV1, which has none.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @param {number} limit
 * @param {boolean} [raw]
 * @returns {{u: (n: number) => number, skip: (n: number) => void}}
 */
export const rbspReader = (bytes, offset, limit, raw = false) => {
  const data = [];
  let zeros = 0;
  for (let i = offset; i < bytes.length && data.length < limit; i++) {
    const b = bytes[i];
    if (!raw && zeros >= 2 && b === 3) { zeros = 0; continue; }
    zeros = b === 0 ? zeros + 1 : 0;
    data.push(b);
  }
  let pos = 0;
  const u = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = data[pos >> 3];
      const bit = byte === undefined ? 0 : (byte >> (7 - (pos & 7))) & 1;
      v = v * 2 + bit;
      pos++;
    }
    return v;
  };
  return { u, skip: (n) => { pos += n; } };
};

/**
 * \`avc1.PPCCLL\` from the first SPS of an H.264 Annex-B key frame.
 * @param {Uint8Array} bytes
 * @returns {string|null} \`null\` when no SPS is found.
 */
export const parseAvcCodecFromAnnexB = (bytes) => {
  if (!bytes || bytes.length < 5) return null;
  const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');
  for (const nal of annexbNals(bytes)) {
    if ((nal[0] & 0x80) === 0 && (nal[0] & 0x1f) === 7) {
      // profile_idc, constraint flags, and level_idc are the first three RBSP
      // bytes and, with profile_idc always >= 66, never need emulation prevention.
      if (nal.length < 4) return null;
      return \`avc1.\${hex2(nal[1])}\${hex2(nal[2])}\${hex2(nal[3])}\`;
    }
  }
  return null;
};

/**
 * \`hev1.P.C.TL.CC\` from the first SPS of an H.265 Annex-B key frame: the
 * general profile, its compatibility flags as the reversed-bit hexadecimal the
 * codecs registration specifies, the tier and level, and the constraint bytes
 * with trailing zero bytes dropped.
 * @param {Uint8Array} bytes
 * @returns {string|null} \`null\` when no SPS is found.
 */
export const parseHevcCodecFromAnnexB = (bytes) => {
  if (!bytes || bytes.length < 5) return null;
  for (const nal of annexbNals(bytes)) {
    if (((nal[0] >> 1) & 0x3f) !== 33 || nal.length < 16) continue;
    const r = rbspReader(nal, 2, 32);
    r.skip(4 + 3 + 1);
    const profileSpace = r.u(2);
    const tier = r.u(1);
    const profile = r.u(5);
    let compat = 0;
    for (let j = 0; j < 32; j++) compat |= r.u(1) << j;
    const constraints = [];
    for (let j = 0; j < 6; j++) constraints.push(r.u(8));
    const level = r.u(8);
    while (constraints.length > 1 && constraints[constraints.length - 1] === 0) constraints.pop();
    const space = ['', 'A', 'B', 'C'][profileSpace];
    const flags = (compat >>> 0).toString(16).toUpperCase();
    const bytesHex = constraints.map((b) => b.toString(16).toUpperCase()).join('.');
    return \`hev1.\${space}\${profile}.\${flags}.\${tier ? 'H' : 'L'}\${level}.\${bytesHex}\`;
  }
  return null;
};

/**
 * \`av01.P.LLT.DD\` from the sequence header of an AV1 temporal unit: the profile,
 * the first operating point's level and tier, and the bit depth its color
 * configuration declares. Every operating point is read past, and the header
 * as it stands, since AV1 has no emulation prevention.
 * @param {Uint8Array} bytes
 * @returns {string|null} \`null\` when no sequence header is found.
 */
export const parseAv1CodecFromObus = (bytes) => {
  if (!bytes || bytes.length < 2) return null;
  let pos = 0;
  while (pos < bytes.length) {
    const header = bytes[pos];
    const obuType = (header >> 3) & 0x0f;
    const hasExtension = (header & 0x04) !== 0;
    const hasSize = (header & 0x02) !== 0;
    let i = pos + 1 + (hasExtension ? 1 : 0);
    let size = bytes.length - i;
    if (hasSize) {
      size = 0;
      let shift = 0;
      for (;;) {
        if (i >= bytes.length || shift > 28) return null;
        const b = bytes[i++];
        size += (b & 0x7f) * (2 ** shift);
        if ((b & 0x80) === 0) break;
        shift += 7;
      }
    }
    if (obuType === 1) {
      const r = rbspReader(bytes, i, size, true);
      const profile = r.u(3);
      r.skip(1);
      const reduced = r.u(1);
      let level;
      let tier = 0;
      if (reduced) {
        level = r.u(5);
      } else {
        const timingInfo = r.u(1);
        let decoderModel = 0;
        let bufferDelayBits = 0;
        if (timingInfo) {
          r.skip(64);
          if (r.u(1)) {
            let leading = 0;
            while (r.u(1) === 0 && leading < 32) leading++;
            r.skip(leading);
          }
          decoderModel = r.u(1);
          if (decoderModel) {
            bufferDelayBits = r.u(5) + 1;
            r.skip(32 + 5 + 5);
          }
        }
        const displayDelay = r.u(1);
        const points = r.u(5) + 1;
        for (let op = 0; op < points; op++) {
          r.skip(12);
          const opLevel = r.u(5);
          const opTier = opLevel > 7 ? r.u(1) : 0;
          if (op === 0) {
            level = opLevel;
            tier = opTier;
          }
          if (decoderModel && r.u(1)) r.skip(bufferDelayBits * 2 + 1);
          if (displayDelay && r.u(1)) r.skip(4);
        }
      }
      const widthBits = r.u(4) + 1;
      const heightBits = r.u(4) + 1;
      r.skip(widthBits + heightBits);
      let orderHint;
      if (!reduced) {
        if (r.u(1)) r.skip(4 + 3);
        r.skip(3 + 4);
        orderHint = r.u(1);
        if (orderHint) r.skip(2);
        const screenContent = r.u(1) ? 2 : r.u(1);
        if (screenContent > 0 && !r.u(1)) r.skip(1);
        if (orderHint) r.skip(3);
      } else {
        r.skip(3);
      }
      r.skip(3);
      const depth = r.u(1) ? ((profile === 2 && r.u(1)) ? 12 : 10) : 8;
      return \`av01.\${profile}.\${String(level).padStart(2, '0')}\${tier ? 'H' : 'M'}.\${String(depth).padStart(2, '0')}\`;
    }
    pos = i + size;
  }
  return null;
};

/**
 * The VP9 profile a frame's uncompressed header declares.
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export const parseVp9Profile = (bytes) => {
  if (!bytes || bytes.length < 1) return 0;
  const b = bytes[0];
  return ((b >> 5) & 1) | (((b >> 4) & 1) << 1);
};

/**
 * The bit depth a VP9 key frame's uncompressed header declares: 8 for profiles 0
 * and 1, 10 or 12 by the flag that follows the sync code for profiles 2 and 3.
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export const parseVp9BitDepth = (bytes) => {
  const profile = parseVp9Profile(bytes);
  if (profile < 2 || !bytes || bytes.length < 5) return 8;
  const r = rbspReader(bytes, 0, 8);
  r.skip(profile === 3 ? 5 : 4);
  // A shown existing frame or a predicted one carries no color configuration.
  if (r.u(1) || r.u(1)) return 10;
  r.skip(2 + 24);
  return r.u(1) ? 12 : 10;
};

/**
 * The lowest VP9 level whose luma sample rate and picture size admit a stream,
 * as the two digits of the codec string.
 * @param {number} width
 * @param {number} height
 * @param {number} fps
 * @returns {string}
 */
export const vp9Level = (width, height, fps) => {
  const size = width * height;
  const rate = size * (fps > 0 ? fps : 60);
  const levels = [
    ['10', 829440, 36864], ['11', 2764800, 73728], ['20', 4608000, 122880],
    ['21', 9216000, 245760], ['30', 20736000, 552960], ['31', 36864000, 983040],
    ['40', 83558400, 2228224], ['41', 160432128, 2228224], ['50', 311951360, 8912896],
    ['51', 588251136, 8912896], ['52', 1176502272, 8912896], ['60', 1176502272, 35651584],
    ['61', 2353004544, 35651584], ['62', 4706009088, 35651584],
  ];
  for (const [level, maxRate, maxSize] of levels) {
    if (rate <= maxRate && size <= maxSize) return level;
  }
  return '62';
};

/**
 * The lowest AV1 level admitting a stream, as \`seq_level_idx\`; used only when a
 * key frame's sequence header is unreadable. MaxPicSize is its own Annex A limit,
 * far below the product of the axis maxima, since no level admits a picture that
 * is both its widest and its tallest.
 * @param {number} width
 * @param {number} height
 * @param {number} fps
 * @returns {number}
 */
export const av1LevelIdx = (width, height, fps) => {
  const size = width * height;
  const rate = size * (fps > 0 ? fps : 60);
  const levels = [
    [8, 2359296, 6144, 3456, 70778880], [9, 2359296, 6144, 3456, 141557760],
    [12, 8912896, 8192, 4352, 267386880], [13, 8912896, 8192, 4352, 534773760],
    [14, 8912896, 8192, 4352, 1069547520], [15, 8912896, 8192, 4352, 1069547520],
    [16, 35651584, 16384, 8704, 1069547520], [17, 35651584, 16384, 8704, 2139095040],
    [18, 35651584, 16384, 8704, 4278190080], [19, 35651584, 16384, 8704, 4278190080],
  ];
  for (const [idx, maxSize, maxW, maxH, maxRate] of levels) {
    if (size <= maxSize && width <= maxW && height <= maxH && rate <= maxRate) return idx;
  }
  return 19;
};

/**
 * Pre-stream guess of the H.264 codec string. Decoder creation re-derives the
 * exact codec from the first key frame's SPS, and outside Chromium only a
 * conservative baseline is guessed because Safari rejects a stream whose real
 * profile or level exceeds the configured one.
 * @param {number} width
 * @param {number} height
 * @param {boolean} is444 Whether the stream is 4:4:4 full-color.
 * @param {number} fps
 * @param {boolean} chromium Whether the engine takes a High profile guess.
 * @returns {string}
 */
/**
 * The \`level_idc\`, as a two-hex-digit string, an H.264 stream of this geometry declares, floored
 * across the common frame rates like the encoder's own ladder so a rate change moves nothing.
 * Mirrors \`h264_level\` in pixelflux \`codec.rs\`.
 * @param {number} width
 * @param {number} height
 * @param {number} fps
 * @returns {string}
 */
export const h264LevelIdc = (width, height, fps) => {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const mbps = mbs * Math.max(fps > 0 ? fps : 60, 60);
  const levels = [
    [0x29, 8192, 245760], [0x2A, 8704, 522240], [0x32, 22080, 589824], [0x33, 36864, 983040],
    [0x34, 36864, 2073600], [0x3C, 139264, 4177920], [0x3D, 139264, 8355840], [0x3E, 139264, 16711680],
  ];
  for (const [idc, maxFs, maxMbps] of levels) {
    if (mbs <= maxFs && mbps <= maxMbps) return idc.toString(16).toUpperCase().padStart(2, '0');
  }
  return '3E';
};

export const guessAvcCodec = (width, height, is444, fps, chromium) => {
  if (!chromium) return 'avc1.42E01E';
  // The encoders' emitted profile_idc: High (0x64) for 4:2:0, High 4:4:4 (0xF4) for 4:4:4. The
  // level matches the encoder's per-geometry choice (floored across the common rates), so the
  // decoder configured before the first key frame does not reconfigure when its SPS arrives.
  const profile = is444 ? 'F400' : '6400';
  return \`avc1.\${profile}\${h264LevelIdc(width, height, fps)}\`;
};

/**
 * The WebCodecs codec string of a stream, from its key frame where the codec
 * declares it and from the geometry otherwise.
 * @param {string} codec The wire codec name.
 * @param {Uint8Array|null} keyframe The key frame's payload, or \`null\` for a delta.
 * @param {number} width
 * @param {number} height
 * @param {number} fps
 * @param {boolean} is444
 * @param {boolean} chromium
 * @returns {string}
 */
export const codecStringFor = (codec, keyframe, width, height, fps, is444, chromium) => {
  switch (codec) {
    case 'h265':
      return (keyframe && parseHevcCodecFromAnnexB(keyframe)) ||
        (is444 ? 'hev1.4.10.L153.9E.8' : 'hev1.1.6.L153.B0');
    case 'vp8':
      return 'vp8';
    case 'vp9':
      return \`vp09.0\${keyframe ? parseVp9Profile(keyframe) : 0}.\${vp9Level(width, height, fps)}.\${
        String(keyframe ? parseVp9BitDepth(keyframe) : 8).padStart(2, '0')}\`;
    case 'av1':
      return (keyframe && parseAv1CodecFromObus(keyframe)) ||
        \`av01.0.\${String(av1LevelIdx(width, height, fps)).padStart(2, '0')}M.08\`;
    default:
      return (keyframe && parseAvcCodecFromAnnexB(keyframe)) ||
        guessAvcCodec(width, height, is444, fps, chromium);
  }
};

/**
 * The color space a decoder is told to assume, which is every session's: no
 * engine reads it out of an H.264 bitstream. Chromium and Firefox both report
 * \`bt709\` at limited range for a stream whose VUI says otherwise, so a full
 * range session rendered without this hint is wrong by up to eight levels a
 * channel, and both honor the hint exactly. VP8 is held to BT.601 whatever the
 * session converted with, the one value its bitstream can name, because Firefox
 * reads that bit and ignores this; VP9 is told BT.709 because Chromium's
 * decoder does not read the matrix from the frame header.
 * @param {string} codec The wire codec name or WebCodecs codec string.
 * @param {boolean} [fullRange] Whether the session converted at full range.
 * @returns {VideoColorSpaceInit}
 */
export const decoderColorSpace = (codec, fullRange = false) => {
  const vp8 = codec === 'vp8';
  const matrix = vp8 ? 'smpte170m' : 'bt709';
  return { primaries: 'bt709', transfer: 'bt709', matrix, fullRange: !vp8 && !!fullRange };
};

/**
 * Representative decoder configurations, one per codec at the profile and
 * level the encoders emit for a 720p stream, for asking an engine what it can
 * decode before any stream exists.
 */
/**
 * A 16x16 Baseline key frame in Annex B form, for asking a decoder whether it
 * takes H.264 without an \`avcC\` description.
 */
export const H264_ANNEXB_SAMPLE = 'AAAAAWdCwArd7ARAAAADAEAAAA8DxIngAAAAAWjOD8gAAAABZYiEOiYoDg==';

/**
 * The \`avcC\` record of an Annex B key frame's SPS and PPS, for a decoder that
 * takes H.264 only with a description; null when either is missing.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array|null}
 */
export const avcDescription = (bytes) => {
  let sps = null;
  let pps = null;
  for (const nal of annexbNals(bytes)) {
    const type = nal[0] & 0x1f;
    if (type === 7 && !sps) sps = nal;
    else if (type === 8 && !pps) pps = nal;
  }
  if (!sps || !pps) return null;
  const out = new Uint8Array(11 + sps.length + pps.length);
  out.set([1, sps[1], sps[2], sps[3], 0xff, 0xe1, sps.length >> 8, sps.length & 0xff], 0);
  out.set(sps, 8);
  out.set([1, pps.length >> 8, pps.length & 0xff], 8 + sps.length);
  out.set(pps, 11 + sps.length);
  return out;
};

/**
 * An Annex B access unit as length-prefixed NAL units, the framing an \`avcC\`
 * description implies, without its parameter sets and delimiters.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
export const annexbToAvcc = (bytes) => {
  const nals = annexbNals(bytes).filter((nal) => {
    const type = nal[0] & 0x1f;
    return type !== 7 && type !== 8 && type !== 9;
  });
  let size = 0;
  for (const nal of nals) size += 4 + nal.length;
  const out = new Uint8Array(size);
  let pos = 0;
  for (const nal of nals) {
    out[pos] = nal.length >>> 24;
    out[pos + 1] = (nal.length >>> 16) & 0xff;
    out[pos + 2] = (nal.length >>> 8) & 0xff;
    out[pos + 3] = nal.length & 0xff;
    out.set(nal, pos + 4);
    pos += 4 + nal.length;
  }
  return out;
};

/**
 * @param {Uint8Array|null} a
 * @param {Uint8Array|null} b
 * @returns {boolean} Whether both are absent or byte-for-byte equal.
 */
export const sameBytes = (a, b) => {
  if (!a || !b) return !a && !b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

export const PROBE_CODEC_STRINGS = {
  h264: 'avc1.42E01E',
  h265: 'hev1.1.6.L93.B0',
  vp8: 'vp8',
  vp9: 'vp09.00.31.08',
  av1: 'av01.0.05M.08',
};

/**
 * One 10-bit key frame of each format, 320x240 of flat gray, for asking a
 * decoder for a picture rather than for its word: a codec name is its 4:2:0,
 * the name with \`444\` after it its 4:4:4. An engine can accept a 10-bit
 * configuration and then fail the frame, which only decoding one shows.
 * @type {Object<string, string>}
 */
export const TEN_BIT_SAMPLES = {
  h264: 'AAAAAWduAA2mzZQUH7ARAAADAAEAAAMAPA8UKZYAAAABaOvjyyLAAAABZYiEADf//vbw/gNCUJcRzeidMx+/Fbi6NDe9zgACrU8Qb7gsE2lPYBBAAAGfEd0SuCykEBAvSus=',
  h264444: 'AAAAAWf0AA2Q2bKCg/YCIAAAAwAgAAAHgeKFMsAAAAABaOvjxEhEAAABZYiEADf//vaH+A0Lun/9P+C6zp85f52wAAq0QAbCNhAp8AAAAwAAAwAAAwACNw==',
  h265: 'AAAAAUABDAH//wIgAAADAJAAAAMAAAMAPJWYCQAAAAFCAQECIAAAAwCQAAADAAADADygCggPE2WVmkkyvAWgIAAAAwAgAAADA8EAAAABRAHBcrQiQAAAASgBrwhg+Snjmyr/oamsIyBbC7MwAAADAAADAAADAAADAAADAPSA',
  h265444: 'AAAAAUABDAH//wQIAAADAJwIAAADAAA8lZgJAAAAAUIBAQQIAAADAJwIAAADAAA8kAFBAeJssrNJJleAtAQAAAMABAAAAwB4IAAAAAFEAcFyhgxCJAAAASgBrwhg+Snjmyr/oamsIyBbC7MwAAADAAADAAADAAADAAADAPSA',
  vp9: 'kkmDQgAJ+Ad7ABwSDgxJAAAYYAAAZzaRO7i1N12+muU5wAA=',
  vp9444: 'sSTBoQAAn4B3sAHBIODEkAABgGAAAGc2kOnpLRNlZkoaQGA=',
  av1: 'EgAKCwAAAAQ8/7xq+cBAMhcQAJEAhBAggIAAAgF1u6aQC9g5Dyf14A==',
};

/** The 4:4:4 configurations, at the profiles the encoders emit (VP9 profile 1). */
export const PROBE_FULLCOLOR_STRINGS = {
  h264: 'avc1.F4001E',
  h265: 'hev1.4.10.L93.9E.8',
  vp9: 'vp09.01.10.08.03',
};
`,oi=`/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * What a decoder should do with each frame that arrives, so a decoder that
 * falls behind costs the stream as little as possible.
 *
 * A decoder given more than it can decode has to let something go, and what it
 * lets go breaks the frames that predict from it. Where the encoder says what
 * each frame predicts from, the cheapest repair is to drop the frame, tell the
 * server which one went, and hold back only what predicts from it: the encoder
 * predicts past it and decoding resumes on its next frame, no key frame on the
 * wire. Where the encoder says nothing -- a stripe of a striped stream, a codec
 * whose session does not track its references -- the only repair is a key
 * frame, so the gate asks for one instead. A run of drops that the encoder
 * never predicts past is the same case and ends in that request too. A key
 * frame that finds the decoder behind is decoded in place of everything queued
 * ahead of it, all of which predicts from before it and would only be shown
 * late: without that, a decoder slower than the stream falls further behind at
 * every key frame, since each one starts the hold over while the backlog stays.
 *
 * @module
 */

/** Frames of decode backlog that count as falling behind. */
export const OVERLOAD_QUEUE = 6;
/** How long that backlog must stand before a frame is let go, in ms. */
export const OVERLOAD_HOLD_MS = 250;
/** How long frames may go undecodable before a key frame is asked for, in ms. */
export const LOST_RECOVERY_MS = 1000;
/** How many dropped frame ids are remembered. A frame predicts from one of the
 * last few its encoder produced, so nothing is lost by forgetting an older one. */
export const LOST_MEMORY = 64;
/** How far behind the frame being decided a remembered id is forgotten. Frame ids
 * are 16-bit and recur every 65536 frames, which an infinite GOP outlasts; half
 * the id space is far past any reference or frame in flight, and well short of
 * the id coming round again. */
export const LOST_HORIZON = 0x8000;

/**
 * @typedef {'decode'|'flush'|'lost'|'no_key'|'overload'} Decision What to do
 *     with a frame: decode it, decode it after dropping the decoder's backlog
 *     (a key frame behind more than OVERLOAD_QUEUE frames), let it go and report
 *     it lost, or ask for a key frame because none has been decoded yet or
 *     because dropping more would not help.
 */

export class DecodeGate {
  /**
   * @param {object} [options]
   * @param {() => number} [options.now] Monotonic clock in ms.
   */
  constructor({ now = () => performance.now() } = {}) {
    this._now = now;
    this._lost = [];
    this._lostSince = 0;
    this._overloadSince = 0;
    this._haveKey = false;
    this._needKey = false;
  }

  /** The decoder was (re)built, so it needs a key frame before anything else. */
  configured() {
    this._haveKey = false;
    this._needKey = true;
    this._reset();
  }

  /** Nothing decoded so far is usable, so only a key frame is. */
  invalidated() {
    this._needKey = true;
  }

  _reset() {
    this._lost.length = 0;
    this._lostSince = 0;
    this._overloadSince = 0;
  }

  /**
   * @param {boolean} key Whether the frame decodes on its own.
   * @param {number} frameId The frame's own id.
   * @param {number|undefined} reference The id of the frame it predicts from;
   *     its own id, or undefined, where the encoder does not say.
   * @param {number} queueSize Frames the decoder has yet to decode.
   * @returns {Decision}
   */
  decide(key, frameId, reference, queueSize) {
    if (key) {
      this._haveKey = true;
      this._needKey = false;
      this._reset();
      return queueSize > OVERLOAD_QUEUE ? 'flush' : 'decode';
    }
    if (!this._haveKey || this._needKey) return 'no_key';
    const tracked = reference !== undefined && reference !== frameId;
    const now = this._now();
    while (this._lost.length && ((frameId - this._lost[0]) & 0xFFFF) >= LOST_HORIZON) this._lost.shift();
    if (tracked && this._lost.includes(reference)) {
      this._remember(frameId);
      if (now - this._lostSince > LOST_RECOVERY_MS) {
        this._needKey = true;
        return 'overload';
      }
      return 'lost';
    }
    if (queueSize > OVERLOAD_QUEUE) {
      if (!this._overloadSince) this._overloadSince = now;
      else if (now - this._overloadSince > OVERLOAD_HOLD_MS) {
        if (!tracked) {
          this._needKey = true;
          return 'overload';
        }
        this._remember(frameId);
        if (!this._lostSince) this._lostSince = now;
        return 'lost';
      }
      return 'decode';
    }
    this._overloadSince = 0;
    this._lostSince = 0;
    return 'decode';
  }

  _remember(frameId) {
    this._lost.push(frameId);
    if (this._lost.length > LOST_MEMORY) this._lost.shift();
  }
}
`,si=`/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * The frame rate a decoder that cannot keep up asks the server for.
 *
 * A decoder slower than the stream keeps a backlog, which the decode gate
 * (lib/decode-gate.js) answers by letting frames go: each backlog frame is
 * latency on the screen, and each drop a repair on the wire. Asking the server
 * for fewer frames removes both. Once the decoder has stood behind for
 * ENGAGE_S seconds in a row, the pace is CAP_SHARE of the frames it turned out
 * over them, never under CAP_FLOOR, and falls again the same way while it
 * stays behind. After a wait of LIFT_S seconds keeping up the pace rises by
 * LIFT_STEP, and falling behind within REGRET_S of a rise takes the rise back
 * and doubles the wait before the next. A pace rising to CAP_CEILING asks for
 * nothing. A second without frames, a still screen's, counts neither way.
 * @module
 */

/** Mean frames of decode backlog over a second that count as behind. */
export const BEHIND_QUEUE = 4;
/** Seconds behind in a row before the pace falls. */
export const ENGAGE_S = 3;
/** Share of the frames the decoder turned out that the pace asks for. */
export const CAP_SHARE = 0.93;
/** The lowest pace, in frames per second. */
export const CAP_FLOOR = 10;
/** Seconds keeping up before the pace rises, doubled at each regret. */
export const LIFT_S = 20;
/** How far each rise goes. */
export const LIFT_STEP = 1.1;
/** How soon after a rise falling behind takes it back, in seconds. */
export const REGRET_S = 10;
/** A pace rising this high asks for nothing: no display the page follows runs faster. */
export const CAP_CEILING = 240;

export class DecodePace {
  constructor() {
    this.reset();
  }

  /** A new decoder or stream, or a rate the user chose: the pace asks for nothing. */
  reset() {
    /** @type {?number} The frames per second asked for, null for none. */
    this.cap = null;
    this._frames = 0;
    this._decisions = 0;
    this._backlog = 0;
    this._drops = 0;
    this._behind = 0;
    this._behindFrames = 0;
    this._keeping = 0;
    this._wait = LIFT_S;
    this._second = 0;
    this._raisedAt = -Infinity;
    this._beforeRise = null;
  }

  /**
   * A frame the gate decided on.
   * @param {number} backlog Frames the decoder had yet to decode then.
   * @param {boolean} dropped Whether the gate let it, or the backlog, go.
   */
  decided(backlog, dropped) {
    this._decisions++;
    this._backlog += backlog;
    if (dropped) this._drops++;
  }

  /** A frame the decoder turned out. */
  decoded() {
    this._frames++;
  }

  /**
   * Closes a second of the stream.
   * @returns {?number|undefined} The new pace where it changed (null: ask for
   *     nothing), undefined where it stayed.
   */
  second() {
    const now = ++this._second;
    const frames = this._frames;
    const decisions = this._decisions;
    const behind = this._drops > 0 || (decisions > 0 && this._backlog / decisions > BEHIND_QUEUE);
    this._frames = 0;
    this._decisions = 0;
    this._backlog = 0;
    this._drops = 0;
    if (!decisions) return undefined;
    const was = this.cap;
    if (behind) {
      this._keeping = 0;
      this._behindFrames += frames;
      if (++this._behind >= ENGAGE_S) {
        const pace = Math.max(CAP_FLOOR, Math.floor(CAP_SHARE * this._behindFrames / this._behind));
        this._behind = 0;
        this._behindFrames = 0;
        if (this._beforeRise !== null && now - this._raisedAt <= REGRET_S) {
          this.cap = this._beforeRise;
          this._wait *= 2;
        } else if (this.cap === null || pace < this.cap) {
          this.cap = pace;
        }
        this._beforeRise = null;
      }
    } else {
      this._behind = 0;
      this._behindFrames = 0;
      if (this.cap !== null && ++this._keeping >= this._wait) {
        this._keeping = 0;
        const raised = Math.ceil(this.cap * LIFT_STEP);
        this._beforeRise = this.cap;
        this._raisedAt = now;
        this.cap = raised >= CAP_CEILING ? null : raised;
      }
    }
    return this.cap !== was ? this.cap : undefined;
  }
}
`;function ci(e){let t=e||(()=>performance.now()),n=-1/0,r=-1,i=0,a=0,o=()=>i>a?i:a;return{note(e){let o=t();if(e===r){let e=o-n;e>a&&(a=e)}else i=Math.max(a,i*.9),a=0,r=e;n=o},settled:()=>t()-n>=2+o(),waveGapMs:o,settleWaitMs:()=>2+o()}}function li(e){let t=e||(()=>performance.now()),n=-1/0;return()=>n=Math.max(Math.trunc(t()*1e3),n+1)}var ui=.93,di=1.1,fi=class{constructor(){this.reset()}reset(){this.cap=null,this._frames=0,this._decisions=0,this._backlog=0,this._drops=0,this._behind=0,this._behindFrames=0,this._keeping=0,this._wait=20,this._second=0,this._raisedAt=-1/0,this._beforeRise=null}decided(e,t){this._decisions++,this._backlog+=e,t&&this._drops++}decoded(){this._frames++}second(){let e=++this._second,t=this._frames,n=this._decisions,r=this._drops>0||n>0&&this._backlog/n>4;if(this._frames=0,this._decisions=0,this._backlog=0,this._drops=0,!n)return;let i=this.cap;if(r){if(this._keeping=0,this._behindFrames+=t,++this._behind>=3){let t=Math.max(10,Math.floor(ui*this._behindFrames/this._behind));this._behind=0,this._behindFrames=0,this._beforeRise!==null&&e-this._raisedAt<=10?(this.cap=this._beforeRise,this._wait*=2):(this.cap===null||t<this.cap)&&(this.cap=t),this._beforeRise=null}}else if(this._behind=0,this._behindFrames=0,this.cap!==null&&++this._keeping>=this._wait){this._keeping=0;let t=Math.ceil(this.cap*di);this._beforeRise=this.cap,this._raisedAt=e,this.cap=t>=240?null:t}return this.cap===i?void 0:this.cap}},pi=class{constructor({now:e=()=>performance.now()}={}){this._now=e,this._lost=[],this._lostSince=0,this._overloadSince=0,this._haveKey=!1,this._needKey=!1}configured(){this._haveKey=!1,this._needKey=!0,this._reset()}invalidated(){this._needKey=!0}_reset(){this._lost.length=0,this._lostSince=0,this._overloadSince=0}decide(e,t,n,r){if(e)return this._haveKey=!0,this._needKey=!1,this._reset(),r>6?`flush`:`decode`;if(!this._haveKey||this._needKey)return`no_key`;let i=n!==void 0&&n!==t,a=this._now();for(;this._lost.length&&(t-this._lost[0]&65535)>=32768;)this._lost.shift();if(i&&this._lost.includes(n))return this._remember(t),a-this._lostSince>1e3?(this._needKey=!0,`overload`):`lost`;if(r>6){if(!this._overloadSince)this._overloadSince=a;else if(a-this._overloadSince>250)return i?(this._remember(t),this._lostSince||=a,`lost`):(this._needKey=!0,`overload`);return`decode`}return this._overloadSince=0,this._lostSince=0,`decode`}_remember(e){this._lost.push(e),this._lost.length>64&&this._lost.shift()}};Fn(),bn();var mi=null,hi=!1,gi=Nn().then(e=>(mi=e,e)),_i=null,vi=128;function yi(e,t){let n=e-t>>>0;return n!==0&&n<2147483648}function bi(e){let t=new Uint8Array(e);if(e.byteLength<=2)return[];let n=t[1]&-129;if(!n)return _i=null,[e.slice(2)];if(e.byteLength<6+n*4+1)return _i=null,[];let r=(t[2]<<24|t[3]<<16|t[4]<<8|t[5])>>>0,i=6,a=[],o=[];for(let e=0;e<n;e++){let e=t[i+1]<<16|t[i+2]<<8|t[i+3];a.push(e>>10&16383),o.push(e&1023),i+=4}i+=1;let s=i;for(let e=0;e<n;e++)s+=o[e];if(s>e.byteLength)return _i=null,[];let c=[];for(let t=0;t<n;t++)c.push({ts:r-a[t]>>>0,buf:e.slice(i,i+o[t])}),i+=o[t];if(c.push({ts:r,buf:e.slice(i)}),_i===null)return _i=r,[c[c.length-1].buf];let l=[],u=_i;for(let e of c)yi(e.ts,u)&&(l.push(e.buf),u=e.ts);return _i=u,l}function xi(){let e=!1,t=null,s=null,c=null,l=null,u,d=null,f=null,p=null,m=!1,h,g,_,ne=1,v;window.currentAudioBufferSize=0,window.currentAudioUnderrunSamples=0,window.currentAudioWorkletDropped=0,window.currentAudioDropped=0;let b=null,x=null,ce=null,le=!1,ue=null,fe=0,he=!1,ge=!1,_e=0,ye=!1,xe=!0,Se=[],Ce=0,S=!0,w=!0,T=!1,Ne=!1,Fe,Ie=-1,O=0,Re=-1,ze=0,Be=0,Ve=0,He=0,Ue=4e3,We=0,Ge=!1,Ke=!0,k=new Set,qe=!1,Je=null,Ye=!1,Xe=!0,Ze=!0,A=null,Qe=!1,$e=!1;Object.defineProperty(window,"webcamCodec",{configurable:!0,get:()=>A?A.codec:null});let et=`auto`,j=`primary`,tt=`right`,nt=[`use_paint_over_quality`,`cpu_encode_threading`],rt=new Set,it=[`framerate`,`video_crf`,`video_fullcolor`,`video_10bit`,`video_streaming_mode`,`jpeg_quality`,`paint_over_jpeg_quality`,`use_cpu`,`cpu_encode_threading`,`video_paintover_crf`,`video_paintover_burst_frames`,`use_paint_over_quality`,`manual_resolution`,`manual_width`,`manual_height`,`encoder`,`scaleLocallyManual`,`use_browser_cursors`,`rate_control_mode`,`video_bitrate`,`force_aligned_resolution`,`scaling_dpi`],at=null,ot=null,M=null,st=null,ct=null,N=null,lt=32e3,ut=``,dt=null,ft=null,pt=null,mt=null,ht=null,gt=!1,_t=0,vt=0,yt=0,bt=null,xt=null,St=!1,Ct=!1,wt=null,Tt=null,P=[],Et=0,Dt=2e3,F=null,Ot=0,kt=3e3,I=null,At=!1,jt=0,L=0,Mt=0,Nt=3e3,R=e=>`data:text/javascript;charset=utf-8,${encodeURIComponent(e)}`,Pt=1e3;window.manual_resolution=!1;let z=null,B=null,It=null,Rt=null,zt={},Bt={},Gt=null,V=`h264enc-striped`,qt=e=>e!==`jpeg`&&e!==`h264enc-striped`,Jt=e=>e!==`jpeg`,H=!1,U=!1,Yt=!1;function Zt(){return Lt({useCssScaling:H,localScale:sn/96,manual:window.manual_resolution,displayId:j,layouts:t,shared:W,wayland:U})}let Qt=0,$t=0,en=null;function rn(){let e=Zt();window.webrtcInput&&window.webrtcInput.setStreamDensity&&window.webrtcInput.setStreamDensity(e);let t=Qt>0&&Math.abs(e-Qt)>1e-6;Qt=e,t&&j!==`primary`&&!window.manual_resolution&&Rt&&(console.log(`Stream density changed: ${e}.`),Rt())}let an=!1,sn=96;function dn(){return window.manual_resolution?Ht(z,B):Vt()}function pn(){return H&&!window.manual_resolution?96:sn}function mn(e){if(W||sa(`scaling_dpi`,null)!==null)return!1;let t=dn();return t!==sn&&(sn=t,console.log(`DPI follows ${e}: scaling_dpi -> ${t}.`),window.postMessage({type:`scalingDpiFollowed`,value:t},window.location.origin),!0)}let hn=window.devicePixelRatio||1;function vn(){let e=window.devicePixelRatio||1;e!==hn&&(hn=e,mn(`devicePixelRatio changed`)&&Jo(`devicePixelRatio changed`))}let bn=!0,xn=!0,Cn=!0,wn=!0,Tn=!0;function Dn(){let t=Tn,n=j===`display2`||j===`primary`&&e,r=n?!0:t;window.webrtcInput&&typeof window.webrtcInput.setUseBrowserCursors==`function`&&(console.log(`Applying effective cursor setting. Multi-monitor: ${n}, User Pref: ${t}, Final: ${r}`),window.webrtcInput.setUseBrowserCursors(r));try{window.postMessage({type:`effectiveCursorState`,value:r},window.location.origin)}catch{}}let On=!0;function An(){window.webrtcInput&&typeof window.webrtcInput.setRawPointerMotion==`function`&&window.webrtcInput.setRawPointerMotion(On)}let jn=1;function Mn(){window.webrtcInput&&typeof window.webrtcInput.setTrackpadSpeed==`function`&&window.webrtcInput.setTrackpadSpeed(jn)}let Nn=!0;function Pn(){window.webrtcInput&&typeof window.webrtcInput.setGamepadRumble==`function`&&window.webrtcInput.setGamepadRumble(Nn)}let Fn=!0;function Ln(){window.webrtcInput&&typeof window.webrtcInput.setMacCmdAsCtrl==`function`&&window.webrtcInput.setMacCmdAsCtrl(Fn)}let Bn=!0;function Vn(){window.webrtcInput&&typeof window.webrtcInput.setShortcutsEnabled==`function`&&window.webrtcInput.setShortcutsEnabled(Bn)}function Hn(){let e=window.innerHeight*.01;document.documentElement.style.setProperty(`--vh`,`${e}px`)}let Un=0,Wn=new En,Gn=e=>Wn.reencodePng(e).then(e=>e.result),Kn=!0,qn=(()=>{let e=/iPad|iPhone|iPod/.test(navigator.userAgent)||navigator.platform===`MacIntel`&&navigator.maxTouchPoints>1,t=/Firefox|FxiOS/.test(navigator.userAgent),n=/CriOS/.test(navigator.userAgent),r=(navigator.userAgentData&&navigator.userAgentData.brands||[]).some(e=>/Chromium|Google Chrome/.test(e.brand)),i=window.chrome!==void 0;return(r||i)&&!e&&!t&&!n})(),Jn=ln({isChromium:qn,canRead:()=>!!xn,sendRequest:()=>{u&&u.readyState===WebSocket.OPEN&&u.send(`REQUEST_CLIPBOARD`)},digestBytes:async e=>{let{byteLength:t,hash:n}=await Wn.hashBytes(e);return Wt(t,n)}}),Yn=nn(),Qn=on({worker:Wn,clipboardSync:Jn,writer:Yn,toPng:Gn,canWriteLocal:()=>Cn&&wn,binaryEnabled:()=>Kn,isChromium:qn,onPreview:(e,t)=>window.postMessage(cn(e,t),window.location.origin),onImageWritten:e=>(console.log(`Successfully wrote image (${e}) from server to local clipboard.`),window.postMessage({type:`clipboardContentUpdate`,text:`Image (${e}) received from session and copied to clipboard.`},window.location.origin),Jn.captureLocalImageSig()),onImageWriteFailed:e=>fc(e)}),er=Xt(),tr=()=>er.arm(),nr=()=>er.consume(),ir=null;function ar(e,t,n){return ir?ir.sendExplicit(e,t,n):(n&&n(`not connected`,`clipboardSkipNotConnected`),Promise.resolve())}let or=null,sr=0,cr=new URLSearchParams(window.location.search),lr=gn(),ur=fn();if(ur.startsWith(`#display2`)){j=`display2`;let e=ur.split(`-`);if(e.length>1){let t=e[1];[`left`,`right`,`up`,`down`].includes(t)&&(tt=t)}}lr?(m=!0,console.log(`Client is running in Token Authentication mode.`)):ur===`#shared`?(or=`shared`,sr=void 0):ur===`#player2`?(or=`player2`,sr=1):ur===`#player3`?(or=`player3`,sr=2):ur===`#player4`&&(or=`player4`,sr=3);let dr=`idle`,fr=!1,W=or!==null,pr=!0;W&&console.log(`Client is running in ${or} mode.`),j===`display2`&&console.log(`Client is running in Secondary Display mode.`),window.onload=()=>{};let G=ke(),_r=(e,t)=>{try{window.localStorage.setItem(e,t)}catch(t){console.warn(`Selkies: could not persist '${e}' to localStorage:`,t)}},vr=`${G}_prefer_software_decode`,yr=e=>`${new Date().toISOString()} ${e}`,br=e=>{let t=/^(\S+) (.+)$/s.exec(e||``);return t?`since ${t[1]}: ${t[2]}`:`since an earlier load`},K=!1;try{K=window.sessionStorage.getItem(vr)!==null}catch(e){console.warn(`Selkies: could not read the software-decode preference:`,e)}let xr=K,wr=-1/0,kr=3e3,Ar=K?0:-1/0,jr=!1,Mr=e=>{let t=!!(e&&e.full_range);if(t!==jr&&(jr=t,$))try{$.postMessage({type:`wireHints`,fullRange:t})}catch{}},Nr=(e,t=``)=>{if($)try{$.postMessage({type:`wireHints`,software:e})}catch{}K=e;try{e?window.sessionStorage.setItem(vr,yr(t)):window.sessionStorage.removeItem(vr)}catch(e){console.warn(`Selkies: could not store the software-decode preference:`,e)}},Pr=e=>K?{...e,hardwareAcceleration:`prefer-software`}:e;async function Fr(e){if((await VideoDecoder.isConfigSupported(e)).supported)return e;if(e.hardwareAcceleration!==`prefer-software`)return null;let t={...e};return delete t.hardwareAcceleration,(await VideoDecoder.isConfigSupported(t)).supported?(K&&(console.warn(`[decode] This browser has no software decoder for ${e.codec}; leaving the choice of decoder to it.`),Nr(!1)),t):null}let Ir=`${G}_crash_count`,Lr=!1,Rr=()=>{if(!(Lr||W)&&!(!(window.fps>0)||!Jt(V)||performance.now()<6e4)){Lr=!0;try{window.localStorage.removeItem(Ir)}catch(e){console.warn(`Selkies: could not clear the decoder crash count:`,e)}}};function zr(){let e=xr&&performance.now()-wr<kr;if(document.hidden||W||window.isFallingBack||e||Mo||!S||V===`jpeg`||typeof VideoDecoder>`u`){He=0;return}let t=performance.now();if(t-We<1e4&&Object.values(zt).some(e=>e&&e.decoder.state===`unconfigured`)){He=0;return}let n=t-Ve<Ue,r=Ve-Be>Ue;if(!n||!r){He=0;return}if(He===0){He=t;return}t-He>=Ue&&(He=0,Gc(Error(`decoder produced no output while chunks arrived`),`no_output`))}let Br=60,Vr=null,Wr=null,Kr=null,Jr=null,Qr=new fi,$r=new pi;function ei(){u&&u.readyState===WebSocket.OPEN&&u.send(`DECODE_PACE ${Jr||0}`)}function ti(e){Jr=e,console.info(e===null?`[decode] the decoder keeps up; the frame rate is the chosen one again.`:`[decode] the decoder keeps up with ${e} fps; asking for that.`),ei()}setInterval(()=>{if(Ia||!qt(V))return;let e=Qr.second();e!==void 0&&ti(e)},1e3);let ni=25,ri=!1,ii=!1,ui=!1,di=60,_i=90,yi=!1,xi=!0,Si=18,Ci=5,wi=!0,Ti=32e4,Ei=8e3,Di=!1,Oi=`connecting`,ki=``,Ai={format:void 0,hardware:null},q={starts:new Map,arrivals:new Map,decodeMs:0,frames:0,format:void 0,hardware:null,probed:``,config:null},ji=new Sr,Mi={keyframes:0,lost:0,keyframesAtOpen:0,lostAtOpen:0},Ni=Er(e=>requestAnimationFrame(e)),Pi=null,Fi=0,Ii=0;function Li(e){let t=q.arrivals.get(e);return q.arrivals.delete(e),t>0?t:NaN}let Ri=e=>performance.timeOrigin+e.presentationTime-Li(Math.round(e.mediaTime*1e6));function zi(e){let t=q.starts.get(e.timestamp);t!==void 0&&(q.starts.delete(e.timestamp),q.decodeMs+=performance.now()-t,q.frames++)}function Bi(e){let t=`${e.codec}:${e.codedWidth}x${e.codedHeight}`;t!==q.probed&&(q.probed=t,VideoDecoder.isConfigSupported({...e,hardwareAcceleration:`prefer-hardware`}).then(e=>{q.probed===t&&(q.hardware=!!e.supported,Hi())}).catch(()=>{}))}let Vi=null,J=new Tr({transport:`websockets`,send:e=>{if(u&&u.readyState===WebSocket.OPEN)u.send(e);else throw Error(`not connected`)},isViewer:()=>W||f===`viewer`,onOpenChange:e=>{if(q.starts.clear(),q.arrivals.clear(),q.decodeMs=0,q.frames=0,Mi.keyframesAtOpen=Mi.keyframes,Mi.lostAtOpen=Mi.lost,$)try{$.postMessage({type:`statsOpen`,open:e})}catch{}if(u&&typeof u.setStats==`function`&&u.setStats(e),Ni.reset(),Ii=0,Pi&&Pi.stop(),Pi=null,clearTimeout(Vi),Vi=null,!e)return;Fi=performance.now(),b&&(Pi=Dr(b,Ni,Ri)),Hi();let t=e=>{Vi=setTimeout(()=>{Ui(),t(1e3)},e)};t(500)}});function Hi(){let e=Ha?Ai:q,t=V===`jpeg`,n=i(V),r=ri&&y[n]||oe[n];r&&c&&c.width>0&&ji.ask({type:`file`,video:{contentType:`video/${n===`vp8`?`webm`:`mp4`}; codecs="${r}"`,width:c.width,height:c.height,bitrate:Ei*1e3,framerate:Br||60}},`${r}:${c.width}x${c.height}`),J.setClient(Object.assign({codec:i(V)||V,resolution:c&&c.width>0?`${c.width}x${c.height}`:``,sink:ut.split(/ \u2014 |; /)[0].replace(/\.$/,``),decode_path:t?co():``},Cr({forcedSoftware:K&&!t,hardwareSupported:t?null:e.hardware,format:t?void 0:e.format,capable:t?null:ji.efficient})))}function Ui(){if($&&Aa)try{$.postMessage({type:`decodeStats`});return}catch{}Wi(null)}function Wi(e){let t=e&&(e.frames>0||e.bytes>0)?e:{...q};q.decodeMs=0,q.frames=0,q.starts.size>64&&q.starts.clear(),q.arrivals.size>256&&q.arrivals.clear(),t.bytes&&J.noteBytes(t.bytes),Hi();let n=performance.now(),r=(n-Fi)/1e3;Fi=n;let i=[Ni.take(),e&&e.shown].filter(Boolean),a=e=>i.reduce((t,n)=>t+n[e],0),o=Pi?Pi.read():{shown:0,dropped:0};Ii+=a(`superseded`)+a(`refused`)+o.dropped;let s={fps:Pi&&!Pi.reported()&&(le||ja===`vtg`)||!(r>0)?window.fps:Math.round((a(`presented`)+o.shown)/r*10)/10,lost_frames:Mi.lost-Mi.lostAtOpen,frames_not_shown:Ii,keyframe_requests:Mi.keyframes-Mi.keyframesAtOpen};a(`delays`)>0&&(s.present_ms=Math.round(a(`delaySum`)/a(`delays`)*100)/100),w&&(s.audio_buffer_ms=Math.round(window.currentAudioBufferDuration||0)),T&&(s.mic=`Opus, 32 kbps`),Ne&&A&&(s.webcam=`${String(A.codec||``).toUpperCase()} ${A.width}x${A.height} at ${A.fps} fps`),t.frames>0&&(s.decode_ms=Math.round(t.decodeMs/t.frames*100)/100),J.clientSample(s)}let Gi=!1,Ki=!1,qi=null,Ji=!1,Yi;window.fps=0,window.videoChunksReceived=0,window.videoDivertOn=!1,window.videoStripeRows={};let Xi=0,Zi=new Set,Qi=performance.now(),$i=performance.now(),Y,ea,X,ta=`cbr`,na=(e,t)=>{let n=`${G}_${e}`,r=n;j===`display2`&&it.includes(e)&&(r=`${n}_${j}`);let i=window.localStorage.getItem(r);return i==null?t:parseInt(i)},ra=(e,t)=>{let n=`${G}_${e}`,r=n;j===`display2`&&it.includes(e)&&(r=`${n}_${j}`);let i=window.localStorage.getItem(r),a=parseFloat(i);return i==null||isNaN(a)?t:a},ia=(e,t)=>{let n=`${G}_${e}`,r=n;j===`display2`&&it.includes(e)&&(r=`${n}_${j}`),t==null?window.localStorage.removeItem(r):_r(r,t.toString())},aa=e=>{let t=`${G}_${e}`;return j===`display2`&&it.includes(e)?`${t}_${j}`:t},Z=(e,t)=>{let n=`${G}_${e}`,r=n;j===`display2`&&it.includes(e)&&(r=`${n}_${j}`);let i=window.localStorage.getItem(r);return i===null?t:i.toString().toLowerCase()===`true`},oa=(e,t)=>{let n=`${G}_${e}`,r=n;j===`display2`&&it.includes(e)&&(r=`${n}_${j}`),t==null?window.localStorage.removeItem(r):_r(r,t.toString())},sa=(e,t)=>{let n=`${G}_${e}`,r=n;return j===`display2`&&it.includes(e)&&(r=`${n}_${j}`),window.localStorage.getItem(r)??t},ca=(e,t)=>{let n=`${G}_${e}`,r=n;j===`display2`&&it.includes(e)&&(r=`${n}_${j}`),t==null?window.localStorage.removeItem(r):_r(r,t.toString())},la=qr(aa,G),ua=la.encoderPick,da=la.fallbackTab;function fa(){try{return window.localStorage.getItem(ua)!==null}catch{return!1}}function pa(e,t){try{window.localStorage.getItem(ua)===null&&_r(ua,sa(`encoder`,``)),window.sessionStorage.setItem(da,yr(t))}catch{}ca(`encoder`,e)}function ma(e){ca(`encoder`,e);try{window.localStorage.removeItem(ua),window.sessionStorage.removeItem(da)}catch{}}function ha(e){try{for(let[e,t]of Object.entries(Gr)){let n=aa(e);window.localStorage.getItem(`${n}_pick`)===null&&_r(`${n}_pick`,window.localStorage.getItem(n)??``),t===null?window.localStorage.removeItem(n):_r(n,t)}window.sessionStorage.setItem(da,yr(e))}catch{}}Yr(aa,G);try{let e=window.sessionStorage.getItem(da),t=window.localStorage.getItem(ua),n=[t===null?``:`the ${sa(`encoder`,``)} encoder (in place of ${t||`the server's`})`,/decoder crash/.test(e||``)?`on a decoder crash's safe settings`:``].filter(Boolean).join(` `);e!==null&&n&&console.warn(`[fallback] This tab streams ${n} ${br(e)}. A new tab or visit puts the picks back.`);let r=window.sessionStorage.getItem(la.displayTab);r!==null&&console.warn(`[display] This tab streams with what its display does ${br(r)}. A new tab or visit puts the picks back.`);let i=window.sessionStorage.getItem(vr);i!==null&&console.warn(`[fallback] This tab decodes video in software ${br(i)}.`);let a=Number(window.localStorage.getItem(Ir))||0;a>0&&console.warn(`[fallback] Decoder crashes in this browser since its last healthy session: ${a}; from the third on, a crash takes the jpeg encoder.`)}catch{}function ga(e){let t=aa(`useCssScaling`),n=window.localStorage.getItem(`${t}_explicit_choice`)===`true`,r=Rn(zn,e,{manualActive:!!window.manual_resolution||z>0},()=>n?window.localStorage.getItem(t):null);return zn.toServer(r)}function _a(e){return Rn(Xn,e,{macDesktop:Ae()},e=>sa(e,null))}function va(e){return Rn(Zn,e,{macDesktop:Ae()},e=>sa(e,null))}function ya(e){console.log(`Sanitizing and storing settings based on server payload.`);let t={},n=e=>{let t=`${G}_${e}`;return j===`display2`&&it.includes(e)?`${t}_${j}`:t};for(let r in e){if(!Object.prototype.hasOwnProperty.call(e,r))continue;let i=e[r],a=$n(r),o=n(a),s=window.localStorage.getItem(o)===null;if(i.min!==void 0&&i.max!==void 0){let e=ra(a,i.default);s?window[r]=e:e<i.min||e>i.max?(console.log(`Sanitizing '${r}': stored value ${e} out of range [${i.min}-${i.max}]. Reverting to server default ${i.default}.`),window.localStorage.removeItem(o),window[r]=i.default,t[r]=i.default):window[r]=e}else if(i.allowed!==void 0){let e=!isNaN(parseFloat(i.allowed[0])),n=e?na(a,parseInt(i.value,10)).toString():sa(a,i.value),c=t=>{window[r]=e?parseInt(t,10):t};s?c(i.value):i.allowed.includes(n)?(c(n),e?ia(a,parseInt(n,10)):ca(a,n)):(console.log(`Sanitizing '${r}': stored "${n}" not in allowed [${i.allowed.join(`, `)}]. Reverting to server default "${i.value}".`),window.localStorage.removeItem(o),c(i.value),t[r]=i.value)}else if(typeof i.value==`boolean`){let e=i.value;if(i.locked){let n=Z(a,!e);n!==e&&(console.log(`Sanitizing '${r}': setting is locked by server. Client value ${n} is being overwritten with ${e}.`),t[r]=e),window[r]=e}else if(s)window[r]=e,i.overridden&&(t[r]=e);else{let t=Z(a,e);window[r]=t,oa(a,t)}}else i.value!==void 0&&(window[r]=i.value)}return t}Br=ra(`framerate`,Br),ni=na(`video_crf`,ni),ri=Z(`video_fullcolor`,ri),ii=Z(`video_10bit`,ii),ui=Z(`video_streaming_mode`,ui),di=na(`jpeg_quality`,di),_i=na(`paint_over_jpeg_quality`,_i),yi=Z(`use_cpu`,yi),xi=Z(`cpu_encode_threading`,xi),Si=na(`video_paintover_crf`,Si),Ci=na(`video_paintover_burst_frames`,Ci),wi=Z(`use_paint_over_quality`,wi),Ti=na(`audio_bitrate`,Ti),Gi=Z(`debug`,Gi),V=sa(`encoder`,`h264enc`),et=sa(`webcam_encoder`,`auto`),Yi=Z(`scaleLocallyManual`,!0),window.manual_resolution=Z(`manual_resolution`,!1),Fe=Z(`isGamepadEnabled`,!0),H=Z(`useCssScaling`,!1),an=Z(`trackpadMode`,!1),ta=sa(`rate_control_mode`,ta),Ei=na(`video_bitrate`,Ei),bn=Z(`antiAliasingEnabled`,!0),Tn=Z(`use_browser_cursors`,!0),On=Z(`raw_pointer_motion`,Ft.rawPointerMotion),jn=ra(`trackpad_speed`,1),Nn=Z(`gamepad_rumble`,!0),Kn=Z(`enable_binary_clipboard`,Kn),xn=Z(`clipboard_in_enabled`,!0),wn=Z(`clipboard_seamless`,!0),Bn=Z(`keyboard_shortcuts`,!0),Cn=Z(`clipboard_out_enabled`,!0);let ba=gr({automatic:Z(`print_auto`,!0)});Di=Z(`force_aligned_resolution`,Di),W?(z=1280,B=720,console.log(`Shared mode: Initialized manual_width/Height to ${z}x${B}`)):(z=na(`manual_width`,null),B=na(`manual_height`,null)),sn=sa(`scaling_dpi`,null)===null?dn():na(`scaling_dpi`,96);let xa=!1,Sa=e=>{xa=!!e;let t=window.webrtcInput;t&&e&&typeof t.enterGamingMode==`function`?t.enterGamingMode():t&&typeof t.enterFullscreen==`function`?t.enterFullscreen():document.fullscreenElement===null&&document.documentElement.requestFullscreen(e?{keyboardLock:`browser`}:void 0).catch(()=>{})},Ca=()=>{ea&&ea.classList.add(`hidden`),Y&&Y.classList.add(`hidden`),Ks(),console.log(`playStream called in WebSocket mode - UI elements hidden.`)},wa=()=>{if(Y){let e=ki||Oi;Y.textContent=e&&e.charAt(0).toUpperCase()+e.slice(1)}};window.applyTimestamp=e=>{let t=new Date;return`[${`${t.getHours()}:${t.getMinutes()}:${t.getSeconds()}`}] ${e}`};let Q=e=>{let t=Di?16:2;return Math.floor(e/t)*t},Ta=typeof MediaStreamTrackGenerator<`u`,Ea=!1,$=null,Da=null,Oa=!0,ka=!1,Aa=!1,ja=null,Ma=null,Na=!1,Pa=null,Fa=0,Ia=!1,La=null,Ra=0,za=0,Ba=null,Va=!1,Ha=!1,Ua=!1,Wa=0,Ga=!1,Ka=!1,qa=0,Ja=!1,Ya=0;function Xa(){if(!(ja===`canvas`&&ge&&Da&&c&&c.width>=640&&Da.width<640)){Ya=0;return}let e=performance.now();if(!Ya){Ya=e;return}e-Ya>1500&&(Ja=!0,console.info(`[Selkies] worker canvas placeholder never took a committed frame; presenting on the page canvas instead.`),fo())}let Za=`
${oi.replace(/^export /gm,``)}
${si.replace(/^export /gm,``)}
// Video sink and optional in-worker decoder. The sink is a worker-only
// VideoTrackGenerator (its track transferred to the page for <video>.srcObject) or a
// transferred OffscreenCanvas. Encoded chunks are decoded here so no decoded frame
// crosses the thread boundary; a frame transferred in (m.frame) is the warm-up path.
let mode = null, oc = null, ctx = null, writer = null, closed = false, presented = false;
let dec = null, decConfig = null;
const gate = new DecodeGate();
// The frame rate the page asks the server for while the decoder cannot keep up (lib/decode-pace.js).
const pace = new DecodePace();
function resetPace() {
  const was = pace.cap;
  pace.reset();
  if (was !== null) self.postMessage({ type: 'decodePace', fps: null });
}
// Decode figures, gathered only while the page has its stats open and posted as it samples.
let statsOpen = false, statsBytes = 0, statsDecodeMs = 0, statsFrames = 0;
// What reaches the screen from here (lib/present-meter.js): a canvas draw lands
// at this thread's next animation frame, and the arrival the socket's thread
// dated a frame with is kept by its decode timestamp until then. WebKit's Linux
// ports commit a worker canvas by a task queued behind the draw and run a busy
// worker's animation frames only once its queue drains, which would fold draws
// it committed one by one into one; there a draw lands at the next task.
const createPresentMeter = ${Er.toString()};
const isSkiaWebKit = ${D.toString()};
const shown = createPresentMeter(typeof requestAnimationFrame !== 'function' ? null
  : isSkiaWebKit(navigator.userAgent, navigator.platform) ? (land) => setTimeout(land, 0)
  : (land) => requestAnimationFrame(land));
const arrivedAt = new Map();
let compositeArrival = -Infinity;
const arrivalOf = (timestamp) => {
  const at = arrivedAt.get(timestamp);
  arrivedAt.delete(timestamp);
  return at > 0 ? at : NaN;
};
// What the decoder turns out, told to the page whenever it changes (tellFacts).
let statsFormat, statsHardware = null, statsProbed = null, toldFormat, toldHardware = null;
const decodeStarts = new Map();
function noteDecoded(f) {
  const started = decodeStarts.get(f.timestamp);
  if (started === undefined) return;
  decodeStarts.delete(f.timestamp);
  statsDecodeMs += performance.now() - started;
  statsFrames++;
}
// Whether the engine has a hardware decoder for the configured stream, asked once per configuration.
function probeHardware(codec, w, h) {
  const probed = codec + ':' + w + 'x' + h;
  if (probed === statsProbed || typeof VideoDecoder === 'undefined') return;
  statsProbed = probed;
  VideoDecoder.isConfigSupported({ codec: codec, codedWidth: w, codedHeight: h, hardwareAcceleration: 'prefer-hardware' })
    .then((r) => { if (statsProbed === probed) { statsHardware = !!r.supported; tellFacts(); } })
    .catch(() => {});
}
// Tells the page, once per change, the pixel format of the decoder's frames and
// whether the engine has a hardware decoder for its configuration.
function tellFacts() {
  if (statsFormat === toldFormat && statsHardware === toldHardware) return;
  toldFormat = statsFormat; toldHardware = statsHardware;
  self.postMessage({ type: 'decodeFacts', format: statsFormat, hardware: statsHardware });
}
function setStatsOpen(open) {
  statsOpen = open;
  decodeStarts.clear();
  statsBytes = 0; statsDecodeMs = 0; statsFrames = 0;
  shown.reset(); arrivedAt.clear(); compositeArrival = -Infinity;
}
// The figures since the page's last sample, posted when it takes the next.
function postDecodeStats() {
  self.postMessage({ type: 'decodeStats', bytes: statsBytes, decodeMs: statsDecodeMs, frames: statsFrames, shown: shown.take() });
  statsBytes = 0; statsDecodeMs = 0; statsFrames = 0;
  if (decodeStarts.size > 64) decodeStarts.clear();
  if (arrivedAt.size > 64) arrivedAt.clear();
}
// Consecutive backpressure drops; a stalled consumer never resumes on its own.
let sinkDrops = 0;
// Keyframe-request throttle while decode is backed up.
let lastNeedKey = 0;
const sendNeedKey = (reason) => {
  const now = Date.now();
  if (now - lastNeedKey < 800) return;
  lastNeedKey = now;
  self.postMessage({ type: 'needKeyframe', reason });
};
const ack = () => self.postMessage({ ack: true });
// The decoded frame waiting for the canvas and when it arrived, and when the
// canvas last finished a draw and how long that draw took.
let waiting = null, waitingAt = NaN, drawQueued = false, drawnAt = -Infinity, drawCost = 0;

// Present one decoded VideoFrame on the active sink, which consumes it; at is
// when it arrived, NaN where unknown. While this thread keeps up with the
// canvas, that is, has been free of drawing for as long as its last draw took,
// a frame is drawn at once, since a timer would only add its own delay.
// Otherwise the canvas takes only the newest frame, drawn by a zero-delay
// timer once the work queued ahead of it has run (WebKit fires a worker's
// timers only while no message waits): a drawImage of a VideoFrame costs
// WebKit 5 to 25 ms and at times over 100, so drawing every frame saturates
// this thread, whose timers then starve while the decode queue grows until
// the gate drops frames. A frame replaced before its draw is closed and
// counted as not shown.
function present(f, at) {
  presentedFrames++;
  if (statsOpen) noteDecoded(f);
  if (mode === 'vtg' && writer && !closed) {
    // Drop on sink backpressure.
    if (writer.desiredSize !== null && writer.desiredSize <= 0) {
      f.close();
      if (statsOpen) shown.refused();
      if (++sinkDrops >= 30) { closed = true; self.postMessage({ type: 'error' }); }
      return;
    }
    sinkDrops = 0;
    // write() consumes/closes f on success; on reject (writable errored) it does NOT, so close it here to avoid leaking the frame.
    writer.write(f).catch(() => { try { f.close(); } catch (_) {} closed = true; self.postMessage({ type: 'error' }); });
    return;
  }
  if (!ctx) { f.close(); return; }
  dropWaiting();
  waiting = f;
  waitingAt = at;
  if (drawQueued) return;
  if (performance.now() - drawnAt >= drawCost) { drawWaiting(); return; }
  drawQueued = true;
  setTimeout(drawWaiting, 0);
}

// Closes the frame waiting for the canvas, replaced by a newer one or left
// behind by the decoder that made it.
function dropWaiting() {
  if (!waiting) return;
  waiting.close();
  waiting = null;
  if (statsOpen) shown.superseded(1);
}

function drawWaiting() {
  drawQueued = false;
  const f = waiting, at = waitingAt;
  if (!f) return;
  waiting = null;
  try {
    if (oc.width !== f.displayWidth || oc.height !== f.displayHeight) { oc.width = f.displayWidth; oc.height = f.displayHeight; }
    const start = performance.now();
    ctx.drawImage(f, 0, 0);
    drawnAt = performance.now();
    drawCost = drawnAt - start;
    if (statsOpen) shown.drawn(at);
    // Tell the page the OffscreenCanvas has real content so it can hide the
    // main canvas (hiding it before this point flashes black).
    if (!presented) { presented = true; self.postMessage({ type: 'presented' }); }
  } finally { f.close(); }
}

function closeDecoder() {
  dropWaiting();
  if (dec) { try { if (dec.state !== 'closed') dec.close(); } catch (_) {} dec = null; }
  gate.configured();
  wireCodec = null; wireW = 0; wireH = 0; wireDesc = null;
}

function configureDecoder(codec, w, h, software, description) {
  // Another picture size costs the decoder another rate; a new codec string
  // alone, such as the level a lower rate declares, does not.
  if (decConfig && (decConfig.codedWidth !== w || decConfig.codedHeight !== h)) resetPace();
  closeDecoder();
  try {
    dec = new VideoDecoder({ output: (f) => { pace.decoded(); statsFormat = f.format; tellFacts(); present(f, statsOpen ? arrivalOf(f.timestamp) : NaN); },
                             error: () => { closeDecoder(); self.postMessage({ type: 'decoderError' }); } });
    // configure() is synchronous, so the next chunk decodes without an async gap and
    // an unsupported config surfaces via error(). The page owns the acceleration
    // preference; unset, the UA default takes a hardware decoder where there is one,
    // and the pinned SPS level keeps it from re-initializing mid-stream.
    const cfg = { codec: codec, codedWidth: w, codedHeight: h, optimizeForLatency: true };
    if (software) cfg.hardwareAcceleration = 'prefer-software';
    if (description) cfg.description = description;
    cfg.colorSpace = decoderColorSpace(codec, wireFullRange);
    dec.configure(cfg);
    decConfig = cfg;
    probeHardware(codec, w, h);
    // A keyframe is required after (re)configure.
    gate.configured();
    return true;
  } catch (err) { closeDecoder(); self.postMessage({ type: 'decoderError' }); return false; }
}

// frameId and reference come off the wire header; a frame that names itself
// predicts from nothing the encoder can say (DecodeGate).
function decodeChunk(key, data, timestamp, frameId, reference, at) {
  if (!dec || dec.state !== 'configured') return;
  const decision = gate.decide(key, frameId, reference, dec.decodeQueueSize);
  pace.decided(dec.decodeQueueSize, decision !== 'decode');
  if (decision === 'lost') { self.postMessage({ type: 'lostFrame', id: frameId }); return; }
  if (decision === 'flush') {
    try { dec.reset(); dec.configure(decConfig); }
    catch (err) { closeDecoder(); self.postMessage({ type: 'decoderError' }); return; }
  } else if (decision !== 'decode') { sendNeedKey(decision); return; }
  if (statsOpen) {
    decodeStarts.set(timestamp, performance.now());
    if (at > 0) arrivedAt.set(Math.trunc(timestamp), at);
  }
  try { dec.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: timestamp, data: data })); }
  catch (err) { closeDecoder(); self.postMessage({ type: 'decoderError' }); }
}

// Raw stripes routed straight from the socket worker, so decode and
// presentation never touch the page. The header is parsed here and the codec
// is derived from each keyframe's SPS; hints carry the page's fallback guess
// and acceleration preference. Wire stats go up once a second for the page's
// counters, watchdogs, and fps, with the row layout this side is decoding.
let wireCodec = null, wireW = 0, wireH = 0, wireHint = null, wireSoftware = false, wireChromium = false;
// The range the session converted at, and the one each decoder was configured
// with: a decoder outlives the report that names the range, so a change has to
// reach it as a reconfigure rather than only the next configure.
let wireFullRange = false, wireRange = false;
// H.264 as this engine takes it: Annex B as sent, or length-prefixed NAL units
// behind the key frame's avcC description where Annex B is refused.
let wireAvcc = false, wireDesc = null;
const avcFramed = (codec) => wireAvcc && typeof codec === 'string' && codec.startsWith('avc1');
// The codec the page's encoder streams; frames of another are the stream it
// just left, still in flight, and must not build (and lose) a decoder here.
let wireExpect = null;
let wireChunks = 0, wireFrames = 0, wireLastId = -1, wireStatsTimer = null;
// The codec helpers by source: a bundler renames the module bindings they
// share, which a stringified function would carry in here unresolved.
${ai.replace(/^export /gm,``)}

// The striped modes (h264enc-striped, jpeg) decode, composite, and present in
// here: a VideoDecoder per row offset or an in-worker JPEG decode, drawn onto
// a persistent back-buffer so undamaged rows survive, presented by the page's
// rule -- last row landed, or the socket and decoders proven quiet (the
// stripe clock), else at the frame-id boundary -- with the presented id going
// back over the wire port so the server paces against what reached the screen.
const createStripeClock = ${ci.toString()};
const createChunkStamp = ${li.toString()};
const chunkStamp = createChunkStamp();
const STRIPE_DECODE_QUEUE_LIMIT = 8;
const JPEG_STRIPE_REORDER_WINDOW = 256;
let stripedOn = false, wirePort = null;
let stripeDecs = {}, jpegLastRowId = {}, jpegRowHeights = {}, jpegPending = 0;
let stripeBack = null, stripeBackCtx = null;
let stripeGeomW = 0, stripeGeomH = 0, stripeGeomKnown = false;
let stripePendingId = null, stripeDirty = false, stripeBottom = false;
let stripeSoftErrors = 0, stripeSoftWindowStart = 0, settleTimer = null;
let presentedFrames = 0, wireDimsW = 0, wireDimsH = 0;
const stripeClock = createStripeClock();

function closeStripeState() {
  for (const y in stripeDecs) {
    const info = stripeDecs[y];
    try { if (info.dec.state !== 'closed') info.dec.close(); } catch (err) {}
  }
  stripeDecs = {}; jpegLastRowId = {}; jpegRowHeights = {}; jpegPending = 0;
  stripePendingId = null; stripeDirty = false; stripeBottom = false;
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
}

// Grows to cover every stripe seen; an explicit geometry change rebuilds it.
function stripeEnsureBack(minW, minH) {
  const w = Math.max(stripeGeomW, minW), h = Math.max(stripeGeomH, minH);
  if (!(w > 0) || !(h > 0)) return false;
  if (!stripeBack) {
    stripeBack = new OffscreenCanvas(w, h);
    stripeBackCtx = stripeBack.getContext('2d', { desynchronized: true, alpha: false });
  } else if (stripeBack.width < w || stripeBack.height < h) {
    const old = stripeBack;
    stripeBack = new OffscreenCanvas(Math.max(old.width, w), Math.max(old.height, h));
    stripeBackCtx = stripeBack.getContext('2d', { desynchronized: true, alpha: false });
    try { stripeBackCtx.drawImage(old, 0, 0); } catch (err) {}
  }
  return true;
}

function stripeDrained() {
  if (jpegPending > 0) return false;
  for (const y in stripeDecs) { if (stripeDecs[y].meta.length > 0) return false; }
  return true;
}

function stripePresent() {
  if (!stripeBack || !stripeDirty) return;
  stripeDirty = false; stripeBottom = false;
  presentedFrames++;
  const at = compositeArrival > 0 ? compositeArrival : NaN;
  compositeArrival = -Infinity;
  if (stripePendingId !== null && wirePort) {
    try { wirePort.postMessage({ presentedId: stripePendingId }); } catch (err) {}
  }
  // A shared viewer learns striped geometry from the composite itself.
  if (!stripeGeomKnown && (stripeBack.width !== wireDimsW || stripeBack.height !== wireDimsH)) {
    wireDimsW = stripeBack.width; wireDimsH = stripeBack.height;
    self.postMessage({ type: 'wireDims', w: wireDimsW, h: wireDimsH });
  }
  if (mode === 'vtg' && writer && !closed) {
    let f = null;
    try { f = new VideoFrame(stripeBack, { timestamp: performance.now() * 1000 }); }
    catch (err) { return; }
    present(f, at);
    return;
  }
  if (ctx) {
    if (oc.width !== stripeBack.width || oc.height !== stripeBack.height) {
      oc.width = stripeBack.width; oc.height = stripeBack.height;
    }
    try { ctx.drawImage(stripeBack, 0, 0); } catch (err) {}
    if (statsOpen) shown.drawn(at);
    if (!presented) { presented = true; self.postMessage({ type: 'presented' }); }
  }
}

function stripeScheduleSettle() {
  if (settleTimer) return;
  const wait = Math.max(1, Math.ceil(stripeClock.settleWaitMs()));
  settleTimer = setTimeout(() => {
    settleTimer = null;
    if (!stripeDirty) return;
    if (stripeDrained() && stripeClock.settled()) { stripePresent(); return; }
    stripeScheduleSettle();
  }, wait);
}

// A new frame id proves the previous frame complete, so it goes up first
// unless quiet already presented it.
function stripeBoundary(frameId) {
  if (stripePendingId !== null && frameId !== stripePendingId && stripeDirty &&
      !(stripeDrained() && stripeClock.settled())) {
    stripePresent();
  }
  stripePendingId = frameId;
}

function stripeMaybePresent() {
  if (!stripeDirty) return;
  if (stripeDrained() && (stripeBottom || stripeClock.settled())) { stripePresent(); return; }
  stripeScheduleSettle();
}

// Draws one decoded stripe at its row offset; always consumes the image. at is
// when the stripe arrived; the composite dates from its newest.
function stripeCompose(image, y, h, frameId, at) {
  const w = image.displayWidth !== undefined ? image.displayWidth : image.width;
  if (!stripeEnsureBack(w, y + h)) { try { image.close(); } catch (err) {} return; }
  stripeBoundary(frameId);
  if (at > compositeArrival) compositeArrival = at;
  try { stripeBackCtx.drawImage(image, 0, y); stripeDirty = true; } catch (err) {}
  try { image.close(); } catch (err) {}
  if (stripeGeomKnown && y + h >= stripeGeomH) stripeBottom = true;
  stripeMaybePresent();
}

function onStripeError(y) {
  const info = stripeDecs[y];
  if (info) {
    try { if (info.dec.state !== 'closed') info.dec.close(); } catch (err) {}
    delete stripeDecs[y];
  }
  const now = Date.now();
  if (now - stripeSoftWindowStart > 10000) { stripeSoftWindowStart = now; stripeSoftErrors = 0; }
  // A burst of failures says decode should leave the worker for the page ladder.
  if (++stripeSoftErrors > 12) { self.postMessage({ type: 'decoderError' }); return; }
  sendNeedKey('stripe_error');
}

function onH264Stripe(buffer, at) {
  if (buffer.byteLength < 13) return;
  const head = new Uint8Array(buffer, 0, 12);
  const key = wireFrameIsKey(head[1]);
  const frameId = (head[2] << 8) | head[3];
  const y = (head[4] << 8) | head[5];
  const w = (head[6] << 8) | head[7];
  const h = (head[8] << 8) | head[9];
  wireChunks++;
  if (frameId !== wireLastId) { wireFrames++; wireLastId = frameId; }
  stripeClock.note(frameId);
  const payload = buffer.slice(12);
  if (payload.byteLength === 0) return;
  let info = stripeDecs[y];
  let codec = info ? info.codec : null;
  const bytes = new Uint8Array(payload);
  if (key) codec = codecStringFor(wireCodecName(head[1]), bytes, w, h, 0, false, wireChromium);
  else if (!codec) codec = wireHint;
  if (!codec) { sendNeedKey('no_codec'); return; }
  const framed = avcFramed(codec);
  const desc = key && framed ? avcDescription(bytes) : (info ? info.desc : null);
  if (!info || info.dec.state !== 'configured' || info.w !== w || info.h !== h || info.codec !== codec
      || info.range !== wireFullRange || (key && framed && !sameBytes(desc, info.desc))) {
    // Only a keyframe may (re)configure a row: deltas against a lost state are noise.
    if (!key) { sendNeedKey('no_key'); return; }
    if (info) { try { if (info.dec.state !== 'closed') info.dec.close(); } catch (err) {} }
    const rowY = y;
    const dec = new VideoDecoder({
      output: (f) => {
        // The row decoder's own frame says what made it; the composite it joins is canvas-backed.
        statsFormat = f.format;
        tellFacts();
        const rowInfo = stripeDecs[rowY];
        const meta = rowInfo && rowInfo.meta.length ? rowInfo.meta.shift() : null;
        stripeCompose(f, rowY, f.displayHeight, meta ? meta.frameId : wireLastId, meta ? meta.at : NaN);
      },
      error: () => onStripeError(rowY),
    });
    try {
      const cfg = { codec: codec, codedWidth: w, codedHeight: h, optimizeForLatency: true };
      if (wireSoftware) cfg.hardwareAcceleration = 'prefer-software';
      if (desc) cfg.description = desc;
      cfg.colorSpace = decoderColorSpace(codec, wireFullRange);
      dec.configure(cfg);
    } catch (err) {
      try { if (dec.state !== 'closed') dec.close(); } catch (e2) {}
      onStripeError(y);
      return;
    }
    info = stripeDecs[y] = { dec: dec, w: w, h: h, codec: codec, desc: desc,
                             range: wireFullRange, gotKey: false, meta: [] };
    probeHardware(codec, w, h);
  }
  if (!key && !info.gotKey) { sendNeedKey('no_key'); return; }
  if (!key && info.dec.decodeQueueSize > STRIPE_DECODE_QUEUE_LIMIT) {
    // Deltas behind a backlog only deepen it; the row is gated until its next IDR.
    info.gotKey = false;
    sendNeedKey('overload');
    return;
  }
  try {
    info.meta.push({ frameId: frameId, at: at });
    const data = framed ? annexbToAvcc(bytes) : payload;
    info.dec.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: chunkStamp(), data: data }));
    if (key) info.gotKey = true;
  } catch (err) {
    info.meta.pop();
    onStripeError(y);
  }
}

function onJpegStripe(buffer, at) {
  if (buffer.byteLength < 7) return;
  const head = new Uint8Array(buffer, 0, 6);
  const frameId = (head[2] << 8) | head[3];
  const y = (head[4] << 8) | head[5];
  wireChunks++;
  if (frameId !== wireLastId) { wireFrames++; wireLastId = frameId; }
  stripeClock.note(frameId);
  const data = buffer.slice(6);
  if (data.byteLength === 0) return;
  const done = (image) => {
    jpegPending--;
    if (!image) { stripeMaybePresent(); return; }
    const last = jpegLastRowId[y];
    if (last !== undefined) {
      const behindBy = (last - frameId) & 0xFFFF;
      if (behindBy > 0 && behindBy <= JPEG_STRIPE_REORDER_WINDOW) {
        try { image.close(); } catch (err) {}
        stripeMaybePresent();
        return;
      }
    }
    jpegLastRowId[y] = frameId;
    const h = image.displayHeight !== undefined ? image.displayHeight : image.height;
    jpegRowHeights[y] = h;
    stripeCompose(image, y, h, frameId, at);
  };
  if (typeof ImageDecoder !== 'undefined') {
    let d = null;
    try { d = new ImageDecoder({ data: data, type: 'image/jpeg' }); }
    catch (err) { return; }
    jpegPending++;
    d.decode().then((r) => { try { d.close(); } catch (err) {} done(r.image); })
      .catch(() => { try { d.close(); } catch (err) {} done(null); });
  } else if (typeof createImageBitmap === 'function') {
    jpegPending++;
    createImageBitmap(new Blob([data], { type: 'image/jpeg' })).then(done).catch(() => done(null));
  }
}

// A wire message is the bytes, or while the page has its stats open, the bytes
// with the arrival the socket's thread dated them with.
function onWire(message) {
  const buffer = message instanceof ArrayBuffer ? message : message && message.buffer;
  const at = message instanceof ArrayBuffer ? NaN : message && message.at;
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 1) return;
  statsBytes += buffer.byteLength;
  if (stripedOn) {
    const type = new Uint8Array(buffer, 0, 1)[0];
    if (type === 0x03) onJpegStripe(buffer, at);
    else if (type === 0x04) onH264Stripe(buffer, at);
    return;
  }
  if (buffer.byteLength < 13) return;
  const head = new Uint8Array(buffer, 0, 12);
  if (wireExpect && wireCodecName(head[1]) !== wireExpect) return;
  const key = wireFrameIsKey(head[1]);
  const frameId = (head[2] << 8) | head[3];
  const w = (head[6] << 8) | head[7];
  const h = (head[8] << 8) | head[9];
  const reference = (head[10] << 8) | head[11];
  wireChunks++;
  if (frameId !== wireLastId) { wireFrames++; wireLastId = frameId; }
  const payload = buffer.slice(12);
  const bytes = new Uint8Array(payload);
  let codec = wireCodec;
  if (key) codec = codecStringFor(wireCodecName(head[1]), bytes, w, h, 0, false, wireChromium);
  else if (!codec) codec = wireHint;
  if (!codec) { sendNeedKey('no_codec'); return; }
  const framed = avcFramed(codec);
  const desc = key && framed ? avcDescription(bytes) : wireDesc;
  if (!dec || dec.state !== 'configured' || codec !== wireCodec || w !== wireW || h !== wireH
      || wireRange !== wireFullRange || (key && framed && !sameBytes(desc, wireDesc))) {
    // Only a keyframe may (re)configure: deltas against a lost state are noise.
    if (!key) { sendNeedKey('no_key'); return; }
    if (!configureDecoder(codec, w, h, wireSoftware, desc)) return;
    wireCodec = codec; wireW = w; wireH = h; wireDesc = desc; wireRange = wireFullRange;
    self.postMessage({ type: 'wireDims', w: w, h: h });
  }
  decodeChunk(key, framed ? annexbToAvcc(bytes) : payload, chunkStamp(), frameId, reference, at);
}

const stripedCaps = {
  stripedDecode: typeof VideoDecoder !== 'undefined',
  jpegDecode: typeof ImageDecoder !== 'undefined' || typeof createImageBitmap === 'function',
};
if (typeof VideoTrackGenerator !== 'undefined') {
  try {
    const g = new VideoTrackGenerator();
    writer = g.writable.getWriter();
    mode = 'vtg';
    self.postMessage(Object.assign({ type: 'mode', mode: 'vtg', track: g.track }, stripedCaps), [g.track]);
  } catch (e) { self.postMessage(Object.assign({ type: 'mode', mode: 'canvas' }, stripedCaps)); }
} else {
  self.postMessage(Object.assign({ type: 'mode', mode: 'canvas' }, stripedCaps));
}

self.onmessage = (e) => {
  const m = e.data;
  // WebKit's Skia ports race the page's paint on an accelerated worker canvas and crash
  // the web process; an unaccelerated one stays out of the race.
  if (m.canvas) {
    oc = m.canvas;
    ctx = oc.getContext('2d', { desynchronized: true, willReadFrequently: isSkiaWebKit(navigator.userAgent, navigator.platform) });
    if (!mode) mode = 'canvas';
    return;
  }
  if (m.type === 'decoderConfig') { configureDecoder(m.codec, m.codedWidth, m.codedHeight, m.software, m.description || null); return; }
  if (m.type === 'closeDecoder') { closeDecoder(); return; }
  if (m.type === 'decodePaceReset') { pace.reset(); return; }
  if (m.type === 'statsOpen') { setStatsOpen(!!m.open); return; }
  if (m.type === 'decodeStats') { postDecodeStats(); return; }
  if (m.type === 'chunk') {
    // Not ready yet; the page will resend a keyframe.
    decodeChunk(m.key, m.data, m.timestamp, m.frameId, m.reference, m.at);
    return;
  }
  if (m.type === 'wireIn') {
    if (m.codecHint) wireHint = m.codecHint;
    wireSoftware = !!m.software;
    wireChromium = !!m.chromium;
    wireAvcc = !!m.avcc;
    wireFullRange = !!m.fullRange;
    wirePort = m.port;
    m.port.onmessage = (ev) => onWire(ev.data);
    if (!wireStatsTimer) {
      wireStatsTimer = setInterval(() => {
        if (!wireChunks && !presentedFrames) return;
        const rows = {};
        if (stripedOn) {
          for (const y in stripeDecs) rows[y] = stripeDecs[y].h;
          for (const y in jpegRowHeights) if (!(y in rows)) rows[y] = jpegRowHeights[y];
        } else if (dec && wireH > 0) {
          rows[0] = wireH;
        }
        self.postMessage({ type: 'wireStats', chunks: wireChunks, frames: wireFrames, lastId: wireLastId, presents: presentedFrames, rows: rows });
        wireChunks = 0; wireFrames = 0; presentedFrames = 0;
        if (!stripedOn && dec) {
          const fps = pace.second();
          if (fps !== undefined) self.postMessage({ type: 'decodePace', fps: fps });
        }
      }, 1000);
    }
    return;
  }
  if (m.type === 'wireMode') {
    const striped = !!m.striped;
    wireExpect = m.codec || null;
    if (striped !== stripedOn) {
      stripedOn = striped;
      // The sink re-announces in the new mode, so the page re-hides its
      // canvas even when the old mode had already consumed 'presented'.
      presented = false;
      if (striped) closeDecoder(); else closeStripeState();
    }
    return;
  }
  if (m.type === 'wireGeom') {
    const know = m.w > 0 && m.h > 0;
    if (know && (m.w !== stripeGeomW || m.h !== stripeGeomH)) {
      stripeGeomW = m.w; stripeGeomH = m.h;
      if (stripeBack && (stripeBack.width !== m.w || stripeBack.height !== m.h)) {
        // A real geometry change; the server keyframes it, so stale rows go.
        stripeBack = null; stripeBackCtx = null;
        stripeDirty = false; stripePendingId = null;
        jpegLastRowId = {}; jpegRowHeights = {};
      }
    }
    stripeGeomKnown = stripeGeomKnown || know;
    return;
  }
  if (m.type === 'wireHints') {
    if (m.codecHint) wireHint = m.codecHint;
    if (m.software !== undefined) wireSoftware = !!m.software;
    if (m.fullRange !== undefined && !!m.fullRange !== wireFullRange) {
      wireFullRange = !!m.fullRange;
      if (dec || Object.keys(stripeDecs).length) sendNeedKey('color_range');
    }
    if (m.chromium !== undefined) wireChromium = !!m.chromium;
    if (m.avcc !== undefined) wireAvcc = !!m.avcc;
    return;
  }
  // Fallback: a main-thread-decoded frame transferred in.
  if (m.frame) {
    present(m.frame, m.at);
    ack();
  }
};`;function Qa(){try{if(typeof MediaStreamTrackGenerator<`u`){let e=new MediaStreamTrackGenerator({kind:`video`});return{track:e,writable:e.writable}}}catch(e){console.warn(`MediaStreamTrackGenerator unavailable, using canvas:`,e)}return null}function $a(){if(!b||!b.paused||!b.srcObject)return;let e=b.play();e&&e.catch&&e.catch(e=>{b.paused&&!ye&&(ye=!0,console.warn(`Video playback refused (${e&&e.name}): the browser waits for a user gesture; the next press or key starts it.`))})}function eo(){if(b&&b.paused&&b.srcObject){let e=b.play();e&&e.then&&e.then(()=>{ye&&(ye=!1,console.log(`Video playback started on a user gesture.`))},()=>{})}h&&h.state===`suspended`&&h.resume().catch(()=>{})}function to(){if(x)return!0;if(!b)return!1;let e=Qa();if(!e)return!1;ce=e.track;try{x=e.writable.getWriter()}catch(e){console.warn(`track writer failed:`,e);try{ce.stop()}catch{}return ce=null,!1}if(x.closed&&x.closed.catch){let e=x;x.closed.catch(()=>{x===e&&yo()})}try{b.srcObject=new MediaStream([ce])}catch(e){console.warn(`srcObject failed:`,e);try{x.close()}catch{}x=null;try{ce.stop()}catch{}return ce=null,!1}return $a(),!0}function no(){if(x){try{x.close()}catch{}x=null}if(ce){try{ce.stop()}catch{}ce=null}if(b)try{b.srcObject=null}catch{}}function ro(e){if(!to())return!1;if(!le&&(le=!0,ue=null,he=!1,ka&&ja!==`vtg`&&Da&&(ka=!1,ge=!1,Da.style.display=`none`),b)){if(b.style.display=`block`,b.style.objectFit=`fill`,$a(),typeof b.requestVideoFrameCallback==`function`){let e=++_e;b.requestVideoFrameCallback(()=>{e===_e&&le&&(he=!0,c&&(c.style.display=`none`))})}else he=!0}if(c&&b&&(he&&c.style.display!==`none`&&(c.style.display=`none`),(xe||ue===null)&&(ue=c.style.cssText,b.style.cssText=ue,b.style.display=`block`,b.style.objectFit=`fill`,xe=!1)),!he&&c&&l&&c.width>0&&c.height>0)try{l.drawImage(e,0,0)}catch{}if(x.desiredSize!==null&&x.desiredSize<=0)return e.close(),J.open&&Ni.refused(),++fe>=30&&(console.warn(`Video track sink stalled (${fe} consecutive drops); rebuilding it.`),yo()),!0;fe=0;let t=x;return x.write(e).catch(()=>{try{e.close()}catch{}x===t&&yo()}),!0}function io(){if($&&c&&c.width>0&&c.height>0)try{$.postMessage({type:`wireGeom`,w:c.width,h:c.height})}catch{}}function ao(){if(!$||!u||typeof u.connectVideo!=`function`)return;let e=new MessageChannel;try{$.postMessage({type:`wireIn`,port:e.port1,codecHint:Ba,software:K,chromium:qn,avcc:pe()===`avcc`,fullRange:jr},[e.port1]);let t=$;de.then(e=>{if($===t)try{t.postMessage({type:`wireHints`,avcc:e===`avcc`})}catch{}}),u.connectVideo(e.port2)}catch(e){console.warn(`Could not connect the socket worker to the video worker:`,e)}io(),oo(!0)}function oo(e){ps();let t=V===`h264enc-striped`||V===`jpeg`,n=Ea&&Aa&&(V===`jpeg`?Ka:Ga),r=!!(u&&typeof u.setVideoDivert==`function`&&Aa&&!Va&&(t?n:Ia&&qt(V)));if($)try{$.postMessage({type:`wireMode`,striped:t,codec:t?null:i(V)})}catch{}(r!==Ha||t!==Ua||e)&&(Ha=r,Ua=t,window.videoDivertOn=r,r||(window.videoStripeRows={}),u&&typeof u.setVideoDivert==`function`&&u.setVideoDivert(r,t?`present`:`receive`),r&&(t&&(cs(),Tc()),io(),po()))}let so=new Set;function co(){let e=ka&&Ka?` in the video worker`:` on the page`;return typeof ImageDecoder<`u`?`ImageDecoder${e}`:typeof createImageBitmap==`function`?`createImageBitmap${e}`:``}function lo(e){ut=e,!so.has(e)&&(so.add(e),console.info(`[Selkies] video sink: ${e}`))}function uo(){if(Ja)return!1;if(Aa)return!0;if($)return!1;try{let e=URL.createObjectURL(new Blob([Za],{type:`text/javascript`}));return qa++,$=new Worker(e),URL.revokeObjectURL(e),J.open&&$.postMessage({type:`statsOpen`,open:!0}),Fa=0,ao(),$.onerror=e=>{console.warn(`video worker error:`,e&&e.message),fo()},$.onmessage=e=>{let t=e.data;if(t){if(t.ack){Fa>0&&Fa--;return}if(t.type===`error`){fo();return}if(t.type===`presented`){Mo&&qo(),ge=!0,ka&&c&&(c.style.display=`none`);return}if(t.type===`needKeyframe`){console.info(`[VideoWorker] keyframe requested: ${t.reason}`),Uc();return}if(t.type===`lostFrame`){Vc(t.id);return}if(t.type===`decodePace`){ti(t.fps);return}if(t.type===`decoderError`){Va=!0,La=null,Ra=0,za=0,Ba=null,oo(),Uc();return}if(t.type===`decodeStats`){Wi(t);return}if(t.type===`decodeFacts`){Ai.format=t.format,Ai.hardware=t.hardware,Hi();return}if(t.type===`wireStats`){window.videoChunksReceived+=t.chunks,t.chunks>0&&(Ve=performance.now()),V===`h264enc-striped`||V===`jpeg`?Xi+=t.presents||0:Wa+=t.frames,(t.presents||0)>0&&(Be=performance.now()),t.lastId>=0&&(Ie=t.lastId,O=performance.now()),t.rows&&(window.videoStripeRows=t.rows),W&&t.chunks>0&&(jt=performance.now()),!Ki&&(t.frames>0||(t.presents||0)>0)&&nc(),Ha&&(po(),Xa());return}if(t.type===`wireDims`){W&&t.w>0&&t.h>0&&(z!==t.w||B!==t.h)&&(z=t.w,B=t.h,console.log(`Shared mode: stream is ${z}x${B} (physical).`),ts(z,B,!0));return}if(t.type===`mode`){if(Ga=!!t.stripedDecode,Ka=!!t.jpegDecode,t.mode===`vtg`&&t.track){if(!b){fo();return}ja=`vtg`,Ma=t.track;try{b.srcObject=new MediaStream([t.track]),$a()}catch(e){console.warn(`VTG srcObject failed:`,e),fo();return}lo(`VideoTrackGenerator in the video worker.`),Ia=!0,Aa=!0,qa=0,io(),oo()}else if(Ta&&qt(V)){lo(`MediaStreamTrackGenerator on the page — this browser exposes no VideoTrackGenerator to a worker.`),fo();return}else{if(ja=`canvas`,lo(Ta?`OffscreenCanvas in the video worker for the striped codecs; full-frame H.264 presents through the page MediaStreamTrackGenerator.`:`OffscreenCanvas in the video worker — this browser exposes no VideoTrackGenerator to a worker and no MediaStreamTrackGenerator on the page, so frames are composited rather than handed to a <video> element.`),!Da){fo();return}try{let e=Da.transferControlToOffscreen();Na=!0,$.postMessage({canvas:e},[e])}catch(e){console.warn(`OffscreenCanvas transfer failed:`,e),fo();return}Ia=!Ta,Aa=!0,qa=0,io(),oo()}}}},!1}catch(e){return console.warn(`video worker init failed, using main canvas:`,e),fo(),!1}}function fo(){let e=ja===`vtg`;lo(Ta?`MediaStreamTrackGenerator on the page.`:`2D canvas on the page — no video worker sink.`);let t=Na;if(ka=!1,Aa=!1,ja=null,Ia=!1,Ga=!1,Ka=!1,Ya=0,oo(),Fa=0,Na=!1,ge=!1,_e++,La=null,Ra=0,za=0,Ba=null,$){try{$.terminate()}catch{}$=null}if(e){if(Ma){try{Ma.stop()}catch{}Ma=null}if(b){try{b.srcObject=null}catch{}b.style.display=`none`}}if(t&&Da){let e=Da.parentNode,t=document.createElement(`canvas`);t.id=Da.id,t.style.display=`none`,e&&e.replaceChild(t,Da),Da=t}else Da&&(Da.style.display=`none`);c&&(c.style.display=`block`)}function po(){let e=ja===`vtg`?b:Da;if(!e)return!1;if(!ka&&(ka=!0,Pa=null,ge=!1,e!==b&&(le?yo():b&&(b.style.display=`none`)),e.style.display=`block`,e.style.objectFit=`fill`,ja===`vtg`)){if($a(),typeof e.requestVideoFrameCallback==`function`){let t=++_e;e.requestVideoFrameCallback(()=>{t===_e&&ka&&(ge=!0,c&&(c.style.display=`none`))})}else ge=!0}return c&&(ge&&c.style.display!==`none`&&(c.style.display=`none`),(xe||Pa===null)&&(Pa=c.style.cssText,e.style.cssText=Pa,e.style.display=`block`,e.style.objectFit=`fill`,xe=!1)),!0}function mo(e){if(!uo()||!po()||(Xa(),Ja))return!1;if(Fa>=3){try{e.close()}catch{}return J.open&&Ni.refused(),!0}try{$.postMessage({frame:e,at:J.open?Li(e.timestamp):NaN},[e]),Fa++}catch{try{e.close()}catch{}return fo(),!0}return!0}let ho=-1/0,go=0;function _o(e,t,n){let r=performance.now();if(r-ho>=5e3){let i=go>0?` (+${go} suppressed)`:``;console.info(`[VideoWorker] decoder (re)configure: codec=${e} ${t}x${n}${La?` (was ${La} ${Ra}x${za})`:``}${i}`),ho=r,go=0}else go++}function vo(e,t,n,r,i,a,o,s){if(Va||!uo()||!po())return!1;let c=pe()===`avcc`&&i.startsWith(`avc1`);if(i!==La||n!==Ra||r!==za){if(c&&!e)return Uc(),!0;_o(i,n,r);let a=c?re(new Uint8Array(t)):null;try{$.postMessage({type:`decoderConfig`,codec:i,codedWidth:n,codedHeight:r,software:K,description:a})}catch{return!1}La=i,Ra=n,za=r,Uc()}let l=c?ie(new Uint8Array(t)).buffer:t;try{$.postMessage({type:`chunk`,key:e,data:l,timestamp:xs(),frameId:a,reference:o,at:s},[l])}catch{return!1}return!0}function yo(){le&&(le=!1,fe=0,he=!1,_e++,b&&(b.style.display=`none`),c&&(c.style.display=``),no())}let bo=(e,t,i,a)=>{let o=t&&r(e)&&t.byteLength?new Uint8Array(t):null;return ee(n(e),o,i,a,Br,ri,qn)},xo=()=>{if(!c)return;if(xe=!0,!bn){c.style.imageRendering!==`pixelated`&&(console.log(`Anti-aliasing disabled by setting. Forcing 'pixelated' rendering.`),c.style.imageRendering=`pixelated`,c.style.setProperty(`image-rendering`,`crisp-edges`,``));return}let e=window.devicePixelRatio||1;W||window.manual_resolution||Math.abs(Zt()-e)>1e-6?c.style.imageRendering!==`auto`&&(console.log(`Smoothing enabled for manual resolution, high-DPR scaling, or shared mode.`),c.style.imageRendering=`auto`):c.style.imageRendering!==`pixelated`&&(console.log(`Setting canvas rendering to 'pixelated' for 1:1 display.`),c.style.imageRendering=`pixelated`,c.style.setProperty(`image-rendering`,`crisp-edges`,``))},So=()=>{let e=document.createElement(`style`);e.textContent=`
body {
  font-family: sans-serif;
  margin: 0;
  padding: 0;
  overflow: hidden;
  background-color: #000;
  color: #fff;
}
#app {
  display: flex;
  flex-direction: column;
  height: calc(var(--vh, 1vh) * 100);
  width: 100%;
}
.video-container {
  flex-grow: 1;
  flex-shrink: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  height: 100%;
  width: 100%;
  position: relative;
  overflow: hidden;
}
.video-container video,
.video-container canvas,
.video-container #overlayInput {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
}
.video-container video {
  max-width: none;
  max-height: none;
  object-fit: contain;
  display: none;
}
.video-container #videoCanvas {
    z-index: 2;
    pointer-events: none;
    display: block;
}
.video-container #overlayInput {
    opacity: 0;
    z-index: 3;
    caret-color: transparent;
    background-color: transparent;
    color: transparent;
    pointer-events: auto;
    -webkit-user-select: none;
    border: none;
    outline: none;
    padding: 0;
    margin: 0;
}
.video-container #playButton {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 10;
}
.hidden {
  display: none !important;
}
.video-container .status-bar {
  position: absolute;
  bottom: 0;
  left: 0;
  width: 100%;
  padding: 5px;
  background-color: rgba(0, 0, 0, 0.7);
  color: #fff;
  text-align: center;
  z-index: 5;
}
#playButton {
  padding: 15px 30px;
  font-size: 1.5em;
  cursor: pointer;
  background-color: rgba(0, 0, 0, 0.5);
  color: white;
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 3px;
  backdrop-filter: blur(5px);
}
.video-container.shared-user-mode #overlayInput {
  cursor: default !important;
}
  `,document.head.appendChild(e)};async function Co(){for(let e of[`h264`,`h265`,`vp9`])ve(e);let e=i(V);a(e)&&(await ve(e)||Z(`video_fullcolor`,!1)&&(console.warn(`[Selkies] full color (4:4:4) is off: this browser decodes ${e} 4:2:0 only.`),ri=!1,oa(`video_fullcolor`,!1)))}let wo=!1;async function To(e){if(!ri||wo||W)return!1;let t=i(V);return!a(t)||Lo(t)===!1||await ve(t)||!ri?!1:(console.warn(`[Selkies] full color (4:4:4) is off: this browser decodes ${t} 4:2:0 only.`),ri=!1,oa(`video_fullcolor`,!1),Jo(e),!0)}async function Eo(){let e=i(V);o(e)&&Z(`video_10bit`,!1)&&(!await we(e,!1)||ri&&a(e)&&!await we(e,!0))&&(console.warn(`[Selkies] 10-bit is off: this browser shows no 10-bit ${e} picture.`),ii=!1,oa(`video_10bit`,!1))}let Do=!1;function Oo(e=V){return In(e,Io,yi,ri)}async function ko(e){if(!ii||Do||W)return!1;let t=i(V),n=Oo();return!o(t)||!n||await we(t,n.fullcolor)||!ii?!1:(console.warn(`[Selkies] 10-bit is off: this browser shows no 10-bit ${t} picture.`),ii=!1,oa(`video_10bit`,!1),Jo(e),!0)}let Ao=e=>/^(avc1\.F4|hev1\.4\.|vp09\.01)/i.test(e),jo=null,Mo=!1,No=null,Po=!1,Fo=null,Io=null;function Lo(e){let t=Io&&Io[e];if(!t||!t.fullcolor)return null;let n=yi||!t.hardware||t.hardware===`vaapi`&&t.fullcolor.hardware===!1&&t.fullcolor.software===!0,r=t.fullcolor[n?`software`:`hardware`];return typeof r==`boolean`?r:null}let Ro=new Set,zo=[`h264enc`,`av1enc`,`vp8enc`,`h265enc`,`vp9enc`,`h264enc-striped`,`jpeg`],Bo=[`av1enc`,`h265enc`,`vp9enc`,`h264enc`,`vp8enc`];function Vo(e,t=V){e&&Ro.add(e);let n=Array.isArray(Fo)&&Fo.length?Fo:zo,r=zo.filter(e=>n.includes(e)),s=e=>qt(e)&&!!(Io&&(Io[i(e)]||{}).hardware),c=Bo.filter(e=>r.includes(e)&&s(e));for(let e of[...c,...r.filter(e=>!s(e))]){if(e===t)continue;if(e===`jpeg`)return e;let n=i(e);if(!Ro.has(n)&&me(e)&&!(wo&&ri&&a(n)&&Lo(n)!==!1&&be(n)===!1)){if(Do&&ii&&o(n)){let t=Oo(e);if(t&&Te(n,t.fullcolor)===!1)continue}return e}}return null}let Ho=e=>Vo(i(e),e)||`jpeg`;function Uo(e,t){if(!(Mo||jo)){if(ii&&!Do&&!W&&o(t)){ko(`no decoder for ${e}`).then(n=>{n||Wo(e,t)});return}Wo(e,t)}}function Wo(e,t){if(!(Mo||jo)){if(Ao(e)&&!wo&&!W){if(!ri)return;To(`no decoder for ${e}`).then(n=>{n||Go(e,t)});return}Go(e,t)}}function Go(e,t){if(Mo||jo)return;let n=!W&&!Po&&V!==`jpeg`?Vo(t):null;if(n){jo=n,console.warn(`This browser has no decoder for ${e}; switching to the ${n} encoder.`),V=n,pa(n,`no decoder for ${e}`),Va=!1,La=null,Ra=0,za=0,Ba=null,oo(),Jo(`no decoder for ${e}`);return}Mo=!0,No={encoder:V,fullcolor:ri},console.error(`This session streams ${e}, which this browser cannot decode.`),Y&&(Y.textContent=`Error: This session streams ${se(t)} video, which this browser cannot decode.`,Y.classList.remove(`hidden`))}function Ko(e,t){if(Po=!!(t&&(t.locked||Array.isArray(t.allowed)&&t.allowed.length===1)),Fo=t&&Array.isArray(t.allowed)?t.allowed.slice():null,jo&&=(e!==jo&&(Po=!0),null),!me(e)){Uo(e,i(e));return}Mo&&(e!==No.encoder||ri!==No.fullcolor)&&qo()}function qo(){Mo=!1,Y&&Y.classList.add(`hidden`)}function Jo(e,t=null){if(!W&&hi){if(u&&u.readyState===WebSocket.OPEN){let n=Qo();t&&t.length>0&&(n.picked=t);let r=`SETTINGS,${JSON.stringify(n)}`;u.send(r),console.log(`[websockets] Sent full settings update. Reason: ${e}`)}else console.warn(`[websockets] Cannot send full settings update. Reason: ${e}. WebSocket not open.`)}}gi.then(e=>{e&&hi&&!W&&u&&u.readyState===WebSocket.OPEN&&u.send(`SETTINGS,${JSON.stringify({keyboardLayout:e})}`)});function Yo(e){let n=document.getElementById(`videoCanvas`),r=null;for(let e of[`videoCanvas`,`videoStream`,`videoWorkerCanvas`]){let t=document.getElementById(e),n=t&&t.getBoundingClientRect?t.getBoundingClientRect():null;if(n&&n.width>0){r=[n.width,n.height];break}}let i=(t||{})[j];return Ut({stream:n&&n.width>0?[n.width,n.height]:null,css:r,realized:i?[i.w,i.h]:null,density:e})}function Xo(){return Hr(window.localStorage.getItem(aa(`framerate`)),Wr?Wr.rate():null,Vr)}function Zo(e){let t=Xo();t!==null&&t!==Kr&&(Br=t,Jo(e))}function Qo(){let e={},t=Zt();$t=t;let n=e=>{let t=`${G}_${e}`;return j===`display2`&&it.includes(e)&&(t=`${t}_${j}`),t},r=e=>window.localStorage.getItem(n(e))!==null&&(!nt.includes(e)||rt.has(e)||window.localStorage.getItem(`${n(e)}_explicit_choice`)===`true`),i=[[`video_crf`,()=>na(`video_crf`,25)],[`encoder`,()=>sa(`encoder`,`h264enc`)],[`manual_resolution`,()=>Z(`manual_resolution`,!1)],[`audio_bitrate`,()=>na(`audio_bitrate`,32e4)],[`video_fullcolor`,()=>Z(`video_fullcolor`,!1)],[`video_10bit`,()=>Z(`video_10bit`,!1)],[`video_streaming_mode`,()=>Z(`video_streaming_mode`,!1)],[`jpeg_quality`,()=>na(`jpeg_quality`,60)],[`paint_over_jpeg_quality`,()=>na(`paint_over_jpeg_quality`,90)],[`use_cpu`,()=>Z(`use_cpu`,!1)],[`cpu_encode_threading`,()=>Z(`cpu_encode_threading`,!0)],[`video_paintover_crf`,()=>na(`video_paintover_crf`,18)],[`video_paintover_burst_frames`,()=>na(`video_paintover_burst_frames`,5)],[`use_paint_over_quality`,()=>Z(`use_paint_over_quality`,!0)],[`scaling_dpi`,()=>na(`scaling_dpi`,96)],[`enable_binary_clipboard`,()=>Z(`enable_binary_clipboard`,!1)],[`rate_control_mode`,()=>sa(`rate_control_mode`,`cbr`)],[`video_bitrate`,()=>na(`video_bitrate`,8e3)],[`force_aligned_resolution`,()=>Z(`force_aligned_resolution`,!1)]];for(let[t,n]of i)r(t)&&(e[t]=n());if(e.encoder!==void 0&&fa()&&(e.encoderFallback=!0),Kr=Xo(),Kr!==null&&(e.framerate=Kr),e.scaling_dpi=pn(),mi&&(e.keyboardLayout=mi),window.manual_resolution&&z!=null&&B!=null)e.manual_resolution=!0,e.manual_width=Q(z),e.manual_height=Q(B);else{let n=document.querySelector(`.video-container`),r=n?n.getBoundingClientRect():{width:window.innerWidth,height:window.innerHeight};e.manual_resolution=!1;let i=Q(r.width*t),a=Q(r.height*t);i>4080&&(i=4080),a>4080&&(a=4080),e.initialClientWidth=i,e.initialClientHeight=a}e.useCssScaling=H,e.displayId=j,e.tabId=C();let a=E(j);return a!==null&&(e.ccStartKbps=a),e.displayScale=Yo(t),j===`display2`&&(e.displayPosition=tt),e.audioRedundancy=!0,e}function $o(e,t){if(W){console.log(`Shared mode: Resolution sending to server is blocked.`);return}let n,r,i=1;window.manual_resolution?(n=Q(e),r=Q(t)):(i=Zt(),Qt=i,window.webrtcInput&&window.webrtcInput.setStreamDensity&&window.webrtcInput.setStreamDensity(i),n=Q(e*i),r=Q(t*i),$t>0&&Math.abs(i-$t)>1e-6&&setTimeout(()=>Jo(`stream density`),0));let a=n>4080||r>4080;n>4080&&(n=4080),r>4080&&(r=4080),en=window.manual_resolution||a?null:[n,r,e,t];let o=`${n}x${r}`;console.log(`Sending resolution to server: ${o}, DisplayID: ${j}, Manual Mode: ${window.manual_resolution}, Pixel Ratio Used: ${i}, useCssScaling: ${H}`),u&&u.readyState===WebSocket.OPEN?u.send(`r,${o},${j}`):console.warn(`Cannot send resolution via WebSocket: Connection not open.`)}function es(){if(!c)return;let e=null,t=!1,n=!1;if(le&&b?(e=b,t=he,n=!0):ka&&(e=ja===`vtg`?b:Da,t=ge),!e)return;let r=c.style.cssText;e.style.cssText=r,e.style.display=`block`,e.style.objectFit=`fill`,n?ue=r:Pa=r,xe=!1,t&&(c.style.display=`none`)}function ts(e,t,n){if(!c||!c.parentElement){console.error(`Cannot apply manual canvas style: Canvas or parent container not found.`);return}if(e<=0||t<=0){console.warn(`Cannot apply manual canvas style: Invalid target dimensions ${e}x${t}`);return}xe=!0,Ns={};let r=W||window.manual_resolution?1:Zt(),i=Q(e*r),a=Q(t*r);(c.width!==i||c.height!==a)&&(c.width=i,c.height=a,console.log(`Canvas internal buffer set to: ${i}x${a}`),io());let o=c.parentElement,s=o.clientWidth,l=o.clientHeight,u,d,f,p;if(n){let n=e/t,r=s/l,o,m;n>r?(o=s,m=s/n):(m=l,o=l*n);let h=(l-m)/2,g=(s-o)/2;u=`${o}px`,d=`${m}px`,f=`${h}px`,p=`${g}px`,c.style.position=`absolute`,c.style.width=u,c.style.height=d,c.style.top=f,c.style.left=p,c.style.objectFit=`contain`,console.log(`Applied manual style (Scaled): CSS ${o.toFixed(2)}x${m.toFixed(2)}, Buffer ${i}x${a}, Pos ${g.toFixed(2)},${h.toFixed(2)}`)}else{let n=window.devicePixelRatio||1,r=e/n,o=t/n;u=`${r}px`,d=`${o}px`;let m=(l-o)/2,h=(s-r)/2;f=`${m}px`,p=`${h}px`,c.style.position=`absolute`,c.style.width=u,c.style.height=d,c.style.top=f,c.style.left=p,c.style.objectFit=`fill`,console.log(`Applied manual style (Exact): CSS ${r.toFixed(2)}x${o.toFixed(2)}, Buffer ${i}x${a}, Pos ${h.toFixed(2)},${m.toFixed(2)}`)}c.style.display=`block`,xo(),es();let m=document.getElementById(`overlayInput`);m&&(m.style.position=`absolute`,m.style.width=u,m.style.height=d,m.style.top=f,m.style.left=p),window.webrtcInput&&typeof window.webrtcInput.resize==`function`&&window.webrtcInput.resize()}function ns(e,t){if(!c)return;if(e<=0||t<=0){console.warn(`Cannot reset canvas style: Invalid stream dimensions ${e}x${t}`);return}Ns={},xe=!0;let n=Zt(),r=Q(e*n),i=Q(t*n);(c.width!==r||c.height!==i)&&(c.width=r,c.height=i,console.log(`Canvas internal buffer reset to: ${r}x${i}`),io());let a=`${e}px`,o=`${t}px`;c.style.width=a,c.style.height=o;let s=document.getElementById(`overlayInput`);s&&(s.style.width=a,s.style.height=o,s.style.position=`absolute`);let l=c.parentElement;if(l){let n=l.clientWidth,a=l.clientHeight,o=Math.floor((n-e)/2),u=Math.floor((a-t)/2);c.style.position=`absolute`,c.style.top=`${u}px`,c.style.left=`${o}px`,s&&(s.style.top=`${u}px`,s.style.left=`${o}px`),console.log(`Reset canvas CSS to ${e}px x ${t}px, Pos ${o},${u}, object-fit: fill. Buffer: ${r}x${i}`)}else c.style.position=`absolute`,c.style.top=`0px`,c.style.left=`0px`,s&&(s.style.top=`0px`,s.style.left=`0px`),console.log(`Reset canvas CSS to ${e}px x ${t}px, Pos 0,0 (no parent metrics), object-fit: fill. Buffer: ${r}x${i}`);c.style.objectFit=`fill`,c.style.display=`block`,xo(),es(),window.webrtcInput&&typeof window.webrtcInput.resize==`function`&&window.webrtcInput.resize()}function rs(){is&&(console.log(`Switching to Auto Mode: Removing direct manual local scaling listener.`),window.removeEventListener(`resize`,is)),It?(console.log(`Switching to Auto Mode: Adding original (auto) debounced resize listener.`),window.removeEventListener(`resize`,It),window.addEventListener(`resize`,It),typeof Rt==`function`?(console.log(`Triggering immediate auto-resize calculation for auto mode.`),Rt()):console.warn(`handleResizeUI function not directly callable from enableAutoResize. Auto-resize will occur on next event.`)):console.warn(`Cannot enable auto-resize: originalWindowResizeHandler not found.`)}let is=()=>{window.manual_resolution&&!W&&z!=null&&B!=null&&z>0&&B>0&&ts(z,B,Yi)};function as(){It&&(console.log(`Switching to Manual Mode Local Scaling: Removing original (auto) resize listener.`),window.removeEventListener(`resize`,It)),console.log(`Switching to Manual Mode Local Scaling: Adding direct manual scaling listener.`),window.removeEventListener(`resize`,is),window.addEventListener(`resize`,is),window.manual_resolution&&!W&&z!=null&&B!=null&&z>0&&B>0&&(console.log(`Applying current manual canvas style after enabling direct manual resize handler.`),ts(z,B,Yi))}function os(){if(!W)return;let e=document.querySelector(`.video-container`);e&&(e.classList.add(`shared-user-mode`),console.log(`Shared mode: Added 'shared-user-mode' class to video container.`));let t=document.getElementById(`globalFileInput`);t&&(t.disabled=!0,console.log(`Shared mode: Disabled globalFileInput.`))}let ss=()=>{So(),Hn(),window.addEventListener(`resize`,Hn),window.addEventListener(`requestFileUpload`,Hs);let e=document.getElementById(`app`);if(!e){console.error(`FATAL: Could not find #app element.`);return}let t=document.createElement(`div`);t.className=`video-container`,Y=document.createElement(`div`),Y.id=`status-display`,Y.className=`status-bar`,Y.textContent=`Connecting...`,t.appendChild(Y),X=document.createElement(`input`),X.type=`search`,X.readOnly=!1,X.autocomplete=`off`,X.inputMode=`none`,X.virtualKeyboardPolicy=`manual`,X.setAttribute(`autocorrect`,`off`),X.setAttribute(`autocapitalize`,`off`),X.setAttribute(`spellcheck`,`false`),X.id=`overlayInput`,t.appendChild(X),c=document.getElementById(`videoCanvas`),c||(c=document.createElement(`canvas`),c.id=`videoCanvas`),t.appendChild(c);let n=cr.get(`offscreen_worker`),r=n===null?Z(`offscreen_worker`,!0):n.toLowerCase()===`true`;Ea=r,Oa=r,!Ea&&Ta?lo(`MediaStreamTrackGenerator on the page.`):Ea||lo(`2D canvas on the page — `+(r?`no MediaStreamTrackGenerator in this browser and no video worker.`:`the video worker is disabled (offscreen_worker=false).`)+` Every frame is drawn by hand, which costs more CPU than a <video> sink.`),(Ta||Ea)&&(b=document.getElementById(`videoStream`),b||(b=document.createElement(`video`),b.id=`videoStream`,b.autoplay=!0,b.muted=!0,b.playsInline=!0,b.disableRemotePlayback=!0),b.style.display=`none`,t.appendChild(b));for(let e of[`pointerdown`,`pointerup`,`touchend`,`keydown`,`click`])window.addEventListener(e,eo,{capture:!0,passive:!0});Ea&&(Da=document.getElementById(`videoWorkerCanvas`),Da||(Da=document.createElement(`canvas`),Da.id=`videoWorkerCanvas`),Da.style.display=`none`,t.appendChild(Da)),Ea&&uo(),W?((!z||z<=0||!B||B<=0)&&(z=1280,B=720),ts(z,B,!0),window.addEventListener(`resize`,()=>{W&&z&&B&&z>0&&B>0&&ts(z,B,!0)}),console.log(`Initialized UI in Shared Mode: Canvas buffer target ${z}x${B} (logical), will scale to fit viewport.`)):window.manual_resolution&&z!=null&&B!=null&&z>0&&B>0?(ts(z,B,Yi),as(),console.log(`Initialized UI in Manual Resolution Mode: ${z}x${B} (logical), ScaleLocally: ${Yi}`)):(ns(1024,768),console.log(`Initialized UI in Auto Resolution Mode (defaulting to 1024x768 logical for now)`)),l=c.getContext(`2d`,{desynchronized:!0}),l||console.error(`Failed to get 2D rendering context`),ea=document.createElement(`button`),ea.id=`playButton`,ea.textContent=`Play Stream`,t.appendChild(ea),ea.classList.add(`hidden`),Y.classList.remove(`hidden`);let i=document.createElement(`div`);i.id=`dev-sidebar`;let a=document.createElement(`input`);if(a.type=`file`,a.id=`globalFileInput`,a.multiple=!0,a.style.display=`none`,document.body.appendChild(a),a.addEventListener(`change`,Us),!document.getElementById(`keyboard-input-assist`)){let e=document.createElement(`input`);e.type=`search`,e.id=`keyboard-input-assist`,e.style.position=`absolute`,e.style.left=`-9999px`,e.style.top=`-9999px`,e.style.width=`1px`,e.style.height=`1px`,e.style.opacity=`0`,e.style.border=`0`,e.style.padding=`0`,e.style.caretColor=`transparent`,e.setAttribute(`aria-hidden`,`true`),e.setAttribute(`autocomplete`,`off`),e.setAttribute(`autocorrect`,`off`),e.setAttribute(`autocapitalize`,`off`),e.setAttribute(`spellcheck`,`false`),document.body.appendChild(e),console.log(`Dynamically added #keyboard-input-assist element.`)}e.appendChild(t),wa(),ea.addEventListener(`click`,Ca),W&&os()};function cs(){console.log(`Clearing all VNC stripe decoders.`);for(let e in zt)if(Object.prototype.hasOwnProperty.call(zt,e)){let t=zt[e];if(t.decoder&&t.decoder.state!==`closed`)try{t.decoder.close(),console.log(`Closed VNC stripe decoder for Y=${e}`)}catch(t){console.error(`Error closing VNC stripe decoder for Y=${e}:`,t)}}zt={},Bt={},console.log(`All VNC stripe decoders and metadata cleared.`)}function ls(e,t){if(Ia&&!Va&&qt(V)){let n=performance.now(),r=Bt[t],i=r&&n-r.last<=1e4?r.count+1:1;if(Bt[t]={count:i,last:n},i<=12){console.warn(`stripe decoder error on Y=${t} (worker path healthy; soft ${i}/12):`,e&&e.name);let n=zt[t];if(n){try{n.decoder.close()}catch{}delete zt[t]}Uc();return}}Gc(e,`stripe_decoder_Y=${t}`)}function us(){for(let e in zt){let t=zt[e];if(t&&t.decoder&&(t.decoder.decodeQueueSize>0||t.pendingChunks&&t.pendingChunks.length>0))return!1}return!0}function ds(e){let t=zt[e];if(t&&t.decoder.state===`configured`&&t.pendingChunks)for(console.log(`Processing ${t.pendingChunks.length} pending chunks for stripe Y=${e}`);t.pendingChunks.length>0;){let n=t.pendingChunks.shift(),r=new EncodedVideoChunk({type:n.type,timestamp:n.timestamp,data:n.data});try{t.decoder.decode(r)}catch(t){console.error(`Error decoding pending chunk for stripe Y=${e}:`,t,r)}}}let fs=[],ps=()=>{},ms=null,hs=null,gs=null,_s=!1,vs=null,ys=0,bs=ci(),xs=li();function Ss(){return c?(ms||(ms=document.createElement(`canvas`),hs=ms.getContext(`2d`,{desynchronized:!0})),(ms.width!==c.width||ms.height!==c.height)&&(ms.width=c.width,ms.height=c.height,gs=null,_s=!1),hs):null}let Cs=null,ws=!1,Ts=0,Es=0;function Ds(){if(Cs){try{Cs.terminate()}catch{}Cs=null}ws=!1,Ts=0,Es=0}function Os(){if(Cs)return!0;if(!Oa||typeof Worker>`u`||typeof OffscreenCanvas>`u`||typeof createImageBitmap!=`function`)return!1;try{let e=URL.createObjectURL(new Blob([`
let back = null, bctx = null;
function ensureBack(w, h) {
  if (!back || back.width !== w || back.height !== h) {
    back = new OffscreenCanvas(w, h);
    bctx = back.getContext('2d', { desynchronized: true, alpha: false });
  }
}
self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'resize') { ensureBack(m.width, m.height); return; }
  if (m.type === 'stripe') {
    if (bctx) { try { bctx.drawImage(m.frame, 0, m.yPos); } catch (err) {} }
    try { m.frame.close(); } catch (err) {}
    return;
  }
  if (m.type === 'commit') {
    if (!back) return;
    createImageBitmap(back).then((bitmap) => { self.postMessage({ type: 'frame', bitmap: bitmap, at: m.at }, [bitmap]); }).catch(() => {});
    return;
  }
};
`],{type:`text/javascript`}));Cs=new Worker(e),URL.revokeObjectURL(e)}catch{return Cs=null,!1}return console.info(`[Selkies] striped codecs: compositing on an OffscreenCanvas in a worker.`),Cs.onerror=()=>Ds(),Cs.onmessage=e=>{let t=e.data;if(t&&t.type===`frame`){if(l&&c&&c.width>0&&c.height>0){try{l.drawImage(t.bitmap,0,0)}catch{}J.open&&Ni.drawn(t.at)}try{t.bitmap.close()}catch{}}},Ts=0,Es=0,!0}function ks(){return Os()?(ws=!0,c.width>0&&c.height>0&&(Ts!==c.width||Es!==c.height)&&(Cs.postMessage({type:`resize`,width:c.width,height:c.height}),Ts=c.width,Es=c.height,gs=null,_s=!1)):(ws=!1,Ss()),!!(c&&c.width>0&&c.height>0)}function As(e,t){if(ws&&Cs)try{Cs.postMessage({type:`stripe`,frame:e,yPos:t},[e]);return}catch{}else if(hs)try{hs.drawImage(e,0,t)}catch{}try{e.close()}catch{}}function js(){Xi++,Be=performance.now(),vs=gs,ys=performance.now();let e=Ms>0?Ms:NaN;if(Ms=-1/0,ws&&Cs)try{Cs.postMessage({type:`commit`,at:e})}catch{}else l&&c.width>0&&c.height>0&&(l.drawImage(ms,0,0),J.open&&Ni.drawn(e))}let Ms=-1/0,Ns={};function Ps(){F!==null&&(clearTimeout(F),F=null),Ot=0}function Fs(){if(W)return;let e=window.videoChunksReceived;Uc(),setTimeout(()=>{if(!(document.hidden||window.videoChunksReceived!==e)&&S&&u&&u.readyState===WebSocket.OPEN){console.warn(`No video since the tab came back; restarting the stream.`);try{u.send(`START_VIDEO`)}catch{return}Ls()}},2500)}function Is(){if(F=null,document.hidden){Ot=0;return}if(!u||u.readyState!==WebSocket.OPEN){Ot=0;return}if(Ot++,Ot<=3){console.warn(`No video after START_VIDEO; resend attempt ${Ot}/3.`);try{u.send(`START_VIDEO`)}catch{}F=setTimeout(Is,kt)}else{console.warn(`START_VIDEO watchdog exhausted; forcing websocket reconnect.`),Ot=0;try{u.close()}catch{}}}function Ls(){F!==null&&clearTimeout(F),Ot=0,F=setTimeout(Is,kt)}function Rs(){I!==null&&(clearInterval(I),I=null),L=0,Mt=0}function zs(){W&&I===null&&(jt=performance.now(),L=0,Mt=0,I=setInterval(()=>{if(document.hidden||fr||dr!==`ready`){jt=performance.now();return}if(!u||u.readyState!==WebSocket.OPEN)return;let e=performance.now(),t=e-jt;if(t<Nt||e<Mt)return;L++;let n=Math.min(Nt*2**(L-1),3e4);Mt=e+n,console.warn(`Shared mode: no video chunk for ${Math.round(t)}ms; resending START_VIDEO (attempt ${L}, next retry in ${n}ms).`);try{u.send(`START_VIDEO`)}catch{}},1e3))}function Bs(e,t){if(Mo&&qo(),q.format=t.format,J.open&&zi(t),qt(V)&&e===0){if(Qr.decoded(),document.hidden||d===`websockets`&&!W&&!S){try{t.close()}catch{}return}if(fs.length>0){for(let e of fs)try{e.frame.close()}catch{}J.open&&Ni.superseded(fs.length),fs.length=0}if(!(Ta&&ro(t))&&!(Ea&&mo(t))){c&&l&&c.width>0&&c.height>0&&(l.drawImage(t,0,0),J.open&&Ni.drawn(Li(t.timestamp)));try{t.close()}catch{}}Be=performance.now(),Ki||nc();return}fs.push({yPos:e,frame:t,frameId:t.timestamp,at:J.open?q.arrivals.get(t.timestamp):NaN}),ps()}let Vs=Sn({canUpload:()=>!W}),Hs=Vs.handleRequestFileUpload,Us=Vs.handleFileInputChange,Ws=Vs.handleDragOver,Gs=Vs.handleDrop,Ks=async()=>{if(Gt===null){if(`wakeLock`in navigator)try{Gt=await navigator.wakeLock.request(`screen`),Gt.addEventListener(`release`,()=>{console.log(`Screen Wake Lock was released automatically.`),Gt=null}),console.log(`Screen Wake Lock is active.`)}catch(e){console.warn(`Could not acquire Wake Lock: ${e.name}, ${e.message}`)}else console.warn(`Wake Lock API is not supported by this browser.`)}},qs=()=>{Ks()},Js=e=>{e.preventDefault()},Ys=async()=>{Gt!==null&&(await Gt.release(),Gt=null)};function Xs(e,t){let n;return function(...r){clearTimeout(n),n=setTimeout(()=>{e.apply(this,r)},t)}}function Zs(){Y&&Y.classList.add(`hidden`),ea&&ea.classList.add(`hidden`)}function Qs(e){if(!Et||typeof e!=`string`)return!1;let t=performance.now();if(t-Et>Dt)return!1;if(e.startsWith(`kh,`)||e.startsWith(`js,h`))return!0;let n=P[P.length-1];if(n&&(e.startsWith(`m,`)||e.startsWith(`m2,`))){let r=n.message.split(`,`),i=e.split(`,`);if(r[0]===i[0]&&r[3]===i[3]&&r[4]===i[4]&&!(Number(i[3])&248))return i[0]===`m2`&&(i[1]=String(Number(r[1])+Number(i[1])),i[2]=String(Number(r[2])+Number(i[2]))),n.message=i.join(`,`),n.at=t,!0}return P.push({message:e,at:t}),!0}function $s(){let e=P;P=[],Et=0;let t=performance.now();for(let{message:n,at:r}of e)t-r>Dt&&!n.startsWith(`ku,`)||u.send(n)}function ec(){St=!1,wt!==null&&clearTimeout(wt),wt=null}function tc(){let e=Tt;Tt=null,e&&!W&&(e.toggled.has(`video`)&&!e.video&&u&&u.readyState===WebSocket.OPEN&&u.send(`STOP_VIDEO`),e.microphone&&Pc(),e.webcam&&Lc())}let nc=()=>{Ki||St&&!Ct||(Ki=!0,ec(),Zs(),console.log(`Stream started (UI elements hidden).`))},rc=()=>{if(Ji){console.log(`Input already initialized. Skipping.`);return}p!==null&&p>0&&(sr=p-1,console.log(`Input Initialization: Applying server-provided slot ${p}. Gamepad will target index ${sr}.`)),Ji=!0,console.log(`Initializing Input system...`);let e,n=e=>{Qs(e)||(u&&u.readyState===WebSocket.OPEN?u.send(e):console.warn(`initializeInput: WebSocket not open, cannot send input message:`,e))};if(!X){console.error(`initializeInput: overlayInput element not found. Cannot initialize input handling.`),Ji=!1;return}if(e=new Ft(X,n,W,sr,H,p),e.displayId=j,e.setFingerScroll(Yt),e.motionBacklog=()=>u?u.bufferedAmount:0,e.setShortcutsEnabled(Bn),e.onmenuhotkey=()=>{window.postMessage({type:`toggleDashboard`},window.location.origin)},e.ongamepadhotkey=()=>{window.postMessage({type:`toggleTouchGamepad`},window.location.origin)},e.gamingMode=xa,e.ongamingmode=e=>{xa=e,window.postMessage({type:`gamingModeUpdate`,active:e},window.location.origin)},e.onnotice=(e,t)=>{window.postMessage({type:`fileUpload`,payload:{status:`warning`,fileName:e,message:t,code:e}},window.location.origin)},e.getWindowResolution=()=>{let e=document.querySelector(`.video-container`);if(!e)return console.warn(`initializeInput: .video-container not found, using window inner dimensions for resolution calculation.`),[window.innerWidth,window.innerHeight];let t=e.getBoundingClientRect();return[t.width,t.height]},e.ongamepadconnected=t=>{console.log(`Client: Gamepad "${t}" connected. isSharedMode: ${W}, isGamepadEnabled (global toggle): ${Fe}`);let n=e.gamepadManager;n?W?(n.enable(),console.log(`Shared mode: Gamepad connected, ensuring its GamepadManager is active for polling.`)):Fe?(n.enable(),console.log(`Primary mode: Gamepad connected, master gamepad toggle is ON. Ensuring its GamepadManager is active.`)):(n.disable(),console.log(`Primary mode: Gamepad connected, but master gamepad toggle is OFF. Disabling its GamepadManager.`)):console.warn(`Client: gamepadManager not found in ongamepadconnected. Cannot control its polling state.`)},e.ongamepaddisconnected=()=>{console.log(`Gamepad disconnected.`)},e.attach(),f===`viewer`){let t=p===null?`(no slot)`:`(gamepad-only slot ${p})`;console.log(`Role is 'viewer' ${t}. Detaching context to disable mouse/keyboard/touch.`),e.detach_context()}window.webrtcInput=e,e.setDisplayLayouts(t,j),Dn(),An(),Ln(),Mn(),Pn(),X&&(X.addEventListener(`pointerdown`,qs),X.addEventListener(`contextmenu`,Js));let r=()=>{if(!Ge)return;if(W){console.log(`Shared mode: handleResizeUI (auto-resize logic) skipped.`),z&&B&&z>0&&B>0&&ts(z,B,!0);return}if(window.manual_resolution){console.log(`handleResizeUI: Auto-resize skipped, manual resolution mode is active.`);return}if(window.enable_resize===!1&&j!==`display2`){console.log(`handleResizeUI: Auto-resize skipped, dynamic resizing is disabled.`);return}console.log(`handleResizeUI: Auto-resize triggered (e.g., by window resize event).`);let t=e.getWindowResolution(),n=Q(t[0]),r=Q(t[1]),i=Zt();Qt=i,e&&e.setStreamDensity&&e.setStreamDensity(i);let a=4080;if(n*i>a&&(n=Math.floor(a/i),n=Q(n)),r*i>a&&(r=Math.floor(a/i),r=Q(r)),n<=0||r<=0){console.warn(`handleResizeUI: Calculated invalid dimensions (${n}x${r}). Skipping resize send.`);return}cs(),window.streamResolutionDiverged=!1,$o(n,r),ns(n,r)};if(Rt=r,It=Xs(()=>{vn(),r()},500),(()=>{let e=null,t=()=>{vn(),typeof Rt==`function`&&Rt(),n()},n=()=>{if(e)try{e.removeEventListener(`change`,t)}catch{}let n=window.devicePixelRatio||1;e=window.matchMedia(`(resolution: ${n}dppx)`),e.addEventListener(`change`,t,{once:!0})};n(),setInterval(()=>{(window.devicePixelRatio||1)!==hn&&t()},1e3)})(),W)console.log(`Shared mode: Auto-resize event listener (originalWindowResizeHandler) NOT attached.`);else if(window.manual_resolution)console.log(`initializeInput: Manual resolution mode active. Initial resolution already sent by onopen.`),z!=null&&B!=null&&z>0&&B>0?as():console.warn(`initializeInput: Manual mode is set, but manual_width/Height are invalid. Canvas might not display correctly.`);else{console.log(`initializeInput: Auto-resolution mode. Attaching 'resize' event listener for subsequent changes.`),window.addEventListener(`resize`,It);let e=document.querySelector(`.video-container`),t,n;if(e){let r=e.getBoundingClientRect();t=Q(r.width),n=Q(r.height)}else t=Q(window.innerWidth),n=Q(window.innerHeight);(t<=0||n<=0)&&(console.warn(`initializeInput: Current auto-calculated dimensions are invalid (${t}x${n}). Defaulting canvas style to 1024x768 (logical) for initial setup. The resolution sent by onopen should prevail on the server.`),t=1024,n=768),ns(t,n),console.log(`initializeInput: Canvas style reset to reflect current auto-dimensions: ${t}x${n} (logical). Initial resolution was already sent by onopen.`)}X&&!W?(X.addEventListener(`dragover`,Ws),X.addEventListener(`drop`,Gs)):X&&W?console.log(`Shared mode: Drag/drop file upload listeners NOT attached to overlayInput.`):console.warn(`initializeInput: overlayInput not found, cannot attach drag/drop listeners.`),console.log(`Input system initialized.`)},ic=null;function ac(){if(ic){try{ic.element.pause()}catch{}ic.element.srcObject=null,ic=null}}async function oc(){let e=ft&&ft!=="default";if(!(typeof AudioContext<`u`&&`setSinkId`in AudioContext.prototype)){if(ic&&ic.context!==h&&ac(),!h||!_)return;if(!e){ic&&(_.disconnect(),_.connect(h.destination),ac());return}if(typeof HTMLMediaElement>`u`||!(`setSinkId`in HTMLMediaElement.prototype)){console.warn(`Browser does not support setSinkId, cannot apply output device preference.`);return}try{if(!ic){let e=h.createMediaStreamDestination();try{e.channelCount=Oc()}catch{}let t=new Audio;t.srcObject=e.stream,ic={context:h,destination:e,element:t}}await ic.element.setSinkId(ft),_.disconnect(),_.connect(ic.destination),await ic.element.play(),console.log(`Playback output set to device: ${ft} (through a media element)`)}catch(e){console.error(`Error routing playback to output device (ID: ${ft}): ${e.name}`,e),h&&_&&(_.disconnect(),_.connect(h.destination)),ac()}return}if(!e){console.log(`No preferred output device set, using default.`);return}if(h){if(h.state===`running`)try{await h.setSinkId(ft),console.log(`Playback AudioContext output set to device: ${ft}`)}catch(e){console.error(`Error setting sinkId on Playback AudioContext (ID: ${ft}): ${e.name}`,e)}else console.warn(`Playback AudioContext not running (state: ${h.state}), cannot set sinkId yet.`)}else console.log(`Playback AudioContext doesn't exist yet, sinkId will be applied on initialization.`)}window.addEventListener(`message`,uc,!1);function sc(){let e=window.webrtcInput&&window.webrtcInput.gamepadManager;if(!e){console.warn(`Client: window.webrtcInput.gamepadManager not found; cannot apply the gamepad toggle.`);return}W||Fe?(e.enable(),console.log(W?`Shared mode: GamepadManager polling stays active.`:`Gamepad toggle ON. Enabling GamepadManager polling.`)):(e.disable(),console.log(`Gamepad toggle OFF. Disabling GamepadManager polling.`))}function cc(e){if(W||j!==`primary`)return;let t=t=>e&&e[t]||null,n=(e,n)=>{let r=t(e);return r&&typeof r.value==`boolean`?r.value:n},r=e=>{let n=t(e);return!!(n&&n.value===!1&&n.locked)},i=e=>!k.has(e),a=!1;i(`video`)&&!n(`video_on_start`,!0)&&S&&(S=!1,Zs(),window.postMessage({type:`pipelineStatusUpdate`,video:!1},window.location.origin),a=!0);let o=n(`audio_enabled`,!0)===!1;i(`audio`)&&!n(`audio_on_start`,!0)&&!o&&w&&(w=!1,window.postMessage({type:`pipelineStatusUpdate`,audio:!1},window.location.origin),s&&s.postMessage({type:`updatePipelineStatus`,data:{isActive:!1}}),u&&u.setAudioActive&&u.setAudioActive(!1),a=!0),i(`microphone`)&&!n(`microphone_on_demand`,!1)&&n(`microphone_on_start`,!1)&&Xe&&!r(`microphone_enabled`)&&Pc(),i(`webcam`)&&!n(`webcam_on_demand`,!1)&&n(`webcam_on_start`,!1)&&Ze&&!r(`webcam_enabled`)&&Lc();let c=window.localStorage.getItem(`${G}_isGamepadEnabled`)!==null;if(i(`gamepad`)&&!c){let e=n(`gamepad_on_start`,!0);Fe!==e&&(Fe=e,sc(),a=!0)}a&&lc()}function lc(){let e={type:`sidebarButtonStatusUpdate`,video:S,audio:w,microphone:T,webcam:Ne,gamepad:Fe};console.log(`Posting sidebarButtonStatusUpdate:`,e),window.postMessage(e,window.location.origin)}function uc(e){if(e.origin!==window.location.origin){console.warn(`Received message from unexpected origin: ${e.origin}. Expected ${window.location.origin}. Ignoring.`);return}let t=e.data;if(typeof t!=`object`||!t){console.warn(`Received non-object message via window.postMessage:`,t);return}if(!t.type){console.warn(`Received message without a type property:`,t);return}switch(t.type){case`setVolume`:typeof t.value==`number`&&_&&(ne=Math.max(0,Math.min(1,t.value)),_.gain.setValueAtTime(ne,h.currentTime));break;case`setMute`:typeof t.value==`boolean`&&_&&(t.value===!0?_.gain.setValueAtTime(0,h.currentTime):_.gain.setValueAtTime(ne,h.currentTime));break;case`sidebarVisibilityChanged`:break;case`statsOpen`:J.setOpen(t.open);break;case`setScaleLocally`:if(W){console.log(`Shared mode: setScaleLocally message ignored (forced true behavior).`);break}typeof t.value==`boolean`?(Yi=t.value,oa(`scaleLocallyManual`,Yi),console.log(`Set scaleLocallyManual to ${Yi} and persisted.`),window.manual_resolution&&z!==null&&B!==null&&(console.log(`Applying new scaling style in manual mode.`),ts(z,B,Yi))):console.warn(`Invalid value received for setScaleLocally:`,t.value);break;case`setSynth`:window.webrtcInput&&typeof window.webrtcInput.setSynth==`function`&&window.webrtcInput.setSynth(t.value);break;case`showVirtualKeyboard`:{if(W){console.log(`Shared mode: showVirtualKeyboard message ignored.`);break}console.log(`Received 'showVirtualKeyboard' message.`);let e=document.getElementById(`keyboard-input-assist`),t=document.getElementById(`overlayInput`);e?(e.value=``,e.focus(),console.log(`Focused #keyboard-input-assist element.`),t.addEventListener(`touchstart`,()=>{document.activeElement===e&&e.blur()},{once:!0,passive:!0})):console.error(`Could not find #keyboard-input-assist element to focus.`);break}case`setUseCssScaling`:if(typeof t.value==`boolean`){let e=H!==t.value;if(H=t.value,t.persist!==!1&&oa(`useCssScaling`,H),console.log(`Set useCssScaling to ${H}${t.persist===!1?`.`:` and persisted.`}`),window.webrtcInput&&typeof window.webrtcInput.updateCssScaling==`function`&&window.webrtcInput.updateCssScaling(H),rn(),e){if(xo(),window.manual_resolution&&z!=null&&B!=null)$o(z,B),ts(z,B,Yi);else if(W)z&&B&&ts(z,B,!0);else if(window.enable_resize!==!1||j===`display2`){let e=window.webrtcInput?window.webrtcInput.getWindowResolution():[window.innerWidth,window.innerHeight],t=Q(e[0]),n=Q(e[1]);$o(t,n),ns(t,n)}Jo(`useCssScaling changed`)}}else console.warn(`Invalid value received for setUseCssScaling:`,t.value);break;case`setAntiAliasing`:if(typeof t.value==`boolean`){let e=bn!==t.value;bn=t.value,oa(`antiAliasingEnabled`,bn),console.log(`Set antiAliasingEnabled to ${bn} and persisted.`),e&&(xo(),es())}else console.warn(`Invalid value received for setAntiAliasing:`,t.value);break;case`setUseBrowserCursors`:typeof t.value==`boolean`?(Tn=t.value,oa(`use_browser_cursors`,Tn),console.log(`Set use_browser_cursors to ${Tn} and persisted.`),Dn()):console.warn(`Invalid value received for setUseBrowserCursors:`,t.value);break;case`setRawPointerMotion`:typeof t.value==`boolean`?(On=t.value,oa(`raw_pointer_motion`,On),console.log(`Set raw_pointer_motion to ${On} and persisted.`),An()):console.warn(`Invalid value received for setRawPointerMotion:`,t.value);break;case`setTrackpadSpeed`:typeof t.value==`number`&&Number.isFinite(t.value)?(jn=t.value,ca(`trackpad_speed`,String(jn)),Mn()):console.warn(`Invalid value received for setTrackpadSpeed:`,t.value);break;case`setGamepadRumble`:typeof t.value==`boolean`?(Nn=t.value,oa(`gamepad_rumble`,Nn),Pn()):console.warn(`Invalid value received for setGamepadRumble:`,t.value);break;case`setMacCmdAsCtrl`:typeof t.value==`boolean`?(Fn=t.value,oa(`mac_cmd_as_ctrl`,Fn),console.log(`Set mac_cmd_as_ctrl to ${Fn} and persisted.`),Ln()):console.warn(`Invalid value received for setMacCmdAsCtrl:`,t.value);break;case`setManualResolution`:{if(W){console.log(`Shared mode: setManualResolution message ignored.`);break}if(window.enable_resize===!1&&j!==`display2`){console.log(`setManualResolution ignored: the server keeps this display's size (enable_resize=false).`);break}let e=parseInt(t.width,10),n=parseInt(t.height,10);if(isNaN(e)||e<=0||isNaN(n)||n<=0){console.error(`Received invalid width/height for setManualResolution:`,t);break}console.log(`Setting manual resolution: ${e}x${n} (logical)`),window.manual_resolution=!0,z=Q(e),B=Q(n),console.log(`Rounded logical resolution to even numbers: ${z}x${B}`),Zr(aa,[`manual_resolution`,`manual_width`,`manual_height`]),ia(`manual_width`,z),ia(`manual_height`,B),oa(`manual_resolution`,!0),as(),mn(`manual resolution set`),$o(z,B),Jo(`manual resolution set`),ts(z,B,Yi),Jt(V)&&(console.log(`Clearing VNC stripe decoders due to manual resolution change.`),cs(),l&&l.setTransform(1,0,0,1,0,0),l.clearRect(0,0,c.width,c.height));break}case`resetResolutionToWindow`:if(W){console.log(`Shared mode: resetResolutionToWindow message ignored.`);break}if(console.log(`Resetting resolution to window size.`),window.manual_resolution=!1,z=null,B=null,Zr(aa,[`manual_resolution`,`manual_width`,`manual_height`]),ia(`manual_width`,null),ia(`manual_height`,null),oa(`manual_resolution`,!1),window.enable_resize!==!1||j===`display2`){let e=window.webrtcInput?window.webrtcInput.getWindowResolution():[window.innerWidth,window.innerHeight];ns(Q(e[0]),Q(e[1])),Jt(V)&&(console.log(`Clearing VNC stripe decoders due to resolution reset to window.`),cs(),l&&l.setTransform(1,0,0,1,0,0),l.clearRect(0,0,c.width,c.height))}mn(`manual resolution cleared`),rs(),Jo(`manual resolution cleared`);break;case`settings`:console.log(`Received settings message:`,t.settings),mc(t.settings);break;case`getStats`:console.log(`Received getStats message.`),_c();break;case`clipboardUpdateFromUI`:if(console.log(`Received clipboardUpdateFromUI message.`),W){console.log(`Shared mode: Clipboard write to server blocked.`);break}ar(t.text);break;case`printRequest`:hr(t.url);break;case`clipboardCopySecret`:Qn.copySecret();break;case`clipboardImageUpdate`:if(W){console.log(`Shared mode: Clipboard image write to server blocked.`),dc(`viewers cannot set the clipboard`,`clipboardSkipReadonly`);break}if(!t.imageBlob){dc(`no image selected`,`clipboardSkipNoImage`);break}if(!Kn){dc(`image clipboard is disabled on the server (enable_binary_clipboard)`,`clipboardSkipBinaryDisabled`);break}ar(t.imageBlob,t.imageBlob.type||`image/png`,dc).catch(e=>{console.warn(`Failed to send uploaded clipboard image:`,e),dc(`send failed: `+e.message,`clipboardSkipSendFailed`)});break;case`pipelineStatusUpdate`:{console.log(`Received pipelineStatusUpdate message:`,t);let e=!1;t.video!==void 0&&S!==t.video&&(S=t.video,e=!0),t.audio!==void 0&&w!==t.audio&&(w=t.audio,e=!0),t.microphone!==void 0&&T!==t.microphone&&(T=t.microphone,e=!0),t.gamepad!==void 0&&Fe!==t.gamepad&&(Fe=t.gamepad,e=!0),e&&lc();break}case`pipelineControl`:{console.log(`Received pipeline control message: pipeline=${t.pipeline}, enabled=${t.enabled}`);let e=t.pipeline,n=t.enabled,r=``;if(e===`video`){if(W){console.log(`Shared mode: Video pipelineControl blocked.`);break}if(k.add(`video`),S!==n){if(S=n,r=n?`START_VIDEO`:`STOP_VIDEO`,!n){if(console.log(`Client: STOP_VIDEO requested via pipelineControl. Clearing canvas visually. Server will send PIPELINE_RESETTING for full state reset.`),l&&c)try{l.setTransform(1,0,0,1,0,0),l.clearRect(0,0,c.width,c.height)}catch(e){console.error(`Error clearing canvas on STOP_VIDEO request:`,e)}}else if(console.log(`Client: START_VIDEO requested via pipelineControl. Clearing canvas visually. Server will send PIPELINE_RESETTING for full state reset.`),l&&c)try{l.setTransform(1,0,0,1,0,0),l.clearRect(0,0,c.width,c.height)}catch(e){console.error(`Error clearing canvas on START_VIDEO request:`,e)}}}else if(e===`audio`){if(W){console.log(`Shared mode: Audio pipeline control blocked.`);break}if(j!==`primary`){console.log(`Secondary display: Audio control blocked.`);break}if(!Ke){console.log(`Audio is disabled. Audio pipeline control blocked.`);break}k.add(`audio`),w!==n&&(w=n,r=n?`START_AUDIO`:`STOP_AUDIO`,s&&s.postMessage({type:`updatePipelineStatus`,data:{isActive:w}}),u&&u.setAudioActive&&u.setAudioActive(w))}else if(e===`microphone`){if(W){console.log(`Shared mode: Microphone control blocked.`);break}if(!Xe){console.log(`Microphone is disabled. Microphone pipeline control blocked.`);break}k.add(`microphone`),Qe=!1,n?Pc():Fc()}else if(e===`webcam`){if(W){console.log(`Shared mode: Webcam control blocked.`);break}if(!Ze){console.log(`Webcam is disabled. Webcam pipeline control blocked.`);break}k.add(`webcam`),$e=!1,n?Lc():Rc()}else console.warn(`Received pipelineControl message for unknown pipeline: ${e}`);if(r&&u&&u.readyState===WebSocket.OPEN)try{u.send(r),console.log(`Sent command to server via WebSocket: ${r}`)}catch(e){console.error(`Error sending ${r} to WebSocket:`,e)}break}case`audioDeviceSelected`:{if(console.log(`Received audioDeviceSelected message:`,t),W&&t.context===`input`){console.log(`Shared mode: Audio input device selection ignored.`);break}if(!Ke){console.log(`Audio control flag is disabled. Audio device selection blocked.`);break}let{context:e,deviceId:n}=t;if(!n){console.warn(`Received audioDeviceSelected message without a deviceId.`);break}e===`input`?(dt=n,T&&(Fc(),setTimeout(Pc,150))):e===`output`?(ft=n,oc()):console.warn(`Unknown context in audioDeviceSelected message: ${e}`);break}case`gamepadControl`:{console.log(`Received gamepad control message: enabled=${t.enabled}`);let e=t.enabled;k.add(`gamepad`),Fe!==e&&(Fe=e,oa(`isGamepadEnabled`,Fe),lc(),sc());break}case`requestFullscreen`:Sa(!1);break;case`requestGamingMode`:Sa(!0);break;case`command`:if(W){console.log(`Shared mode: Arbitrary command sending to server blocked.`);break}if(!pr){console.log(`Command sending suppressed: server has command_enabled=false; not sending 'cmd,'.`);break}if(typeof t.value==`string`){let e=t.value;if(console.log(`Received 'command' message with value: "${e}". Forwarding to WebSocket.`),u&&u.readyState===WebSocket.OPEN)try{u.send(`cmd,${e}`),console.log(`Sent command to server via WebSocket: cmd,${e}`)}catch(e){console.error(`Failed to send command via WebSocket:`,e)}else console.warn(`Cannot send command: WebSocket is not open or not available.`)}else console.warn(`Received 'command' message without a string value:`,t);break;case`touchinput:trackpad`:window.webrtcInput&&typeof window.webrtcInput.setTrackpadMode==`function`&&(an=!0,oa(`trackpadMode`,!0),window.webrtcInput.setTrackpadMode(!0));break;case`touchinput:touch`:window.webrtcInput&&typeof window.webrtcInput.setTrackpadMode==`function`&&(an=!1,oa(`trackpadMode`,!1),window.webrtcInput.setTrackpadMode(!1))}}function dc(e,t){console.warn(`Clipboard image upload skipped: `+e),window.postMessage({type:`fileUpload`,payload:{status:`warning`,fileName:`clipboard-image`,message:e,code:t}},window.location.origin)}function fc(e){let t=Kt()||e&&e.message||String(e);console.error(`Failed to write the session image to the local clipboard:`,e),window.postMessage({type:`fileUpload`,payload:{status:`warning`,fileName:`clipboard-image`,message:t,code:`clipboardImageWriteFailed`}},window.location.origin)}async function pc(e,t=`text/plain`,n=null){let r=(e,t)=>{n&&n(e,t)};if(window.clipboard_enabled===void 0){r(`the session has not reported its clipboard policy yet`,`clipboardSkipNotConnected`);return}if(!window.clipboard_enabled){r(`the server has the clipboard turned off`,`clipboardSkipDisabled`);return}if(!xn){r(`the client-to-session clipboard is turned off`,`clipboardSkipInDisabled`);return}if(!u||u.readyState!==WebSocket.OPEN){console.warn(`Cannot send clipboard data: WebSocket is not open.`),r(`not connected`,`clipboardSkipNotConnected`);return}let i=e instanceof ArrayBuffer||e instanceof Uint8Array,a;i?a=new Uint8Array(e):(a=new TextEncoder().encode(e),t=`text/plain`);let o=e;if(i)try{let{byteLength:e,hash:t}=await Wn.hashBytes(a.slice().buffer);o=Wt(e,t)}catch{}if(!Jn.shouldSend(o,t)){r(`already the current clipboard`,`clipboardSkipUnchanged`);return}let s=!1;await kn(a,t,{worker:Wn,send:e=>u.send(e),waitDrain:async()=>{for(;u.bufferedAmount>65536;)if(await new Promise(e=>setTimeout(e,20)),u.readyState!==WebSocket.OPEN)return s=!0,!1;return!0},chunkRawBytes:16383,nextTid:()=>++Un}),!s&&u.readyState===WebSocket.OPEN?Jn.markSynced(o,t):r(`connection lost during send`,`clipboardSkipSendFailed`)}function mc(e,t,n=!0){let r=t?()=>{}:ia,i=t?()=>{}:oa,a=t?()=>{}:ca;t||Zr(aa,Object.keys(e)),console.log(`Applying settings:`,e);let o=!1;if(e.framerate!==void 0){let n=e.framerate===Or;t||(Qr.reset(),$&&$.postMessage({type:`decodePaceReset`}),Jr!==null&&ti(null)),a(`framerate`,n?Or:String(parseFloat(e.framerate)));let r=n?Xo():parseFloat(e.framerate);Number.isFinite(r)&&(Br=r),o=!0}if(e.webcam_encoder!==void 0){let t=String(e.webcam_encoder);rr.includes(t)&&t!==et&&(et=t,a(`webcam_encoder`,t),A&&(Rc(),Lc()))}if(e.encoder!==void 0){let n=e.encoder;if(t||ma(n),!t&&!me(n)){let t=Ho(n);console.warn(`This browser has no decoder for ${n}; using the ${t} encoder.`),n=t,pa(t,`no decoder for ${e.encoder}`)}V!==n&&(V=n,oo(),a(`encoder`,V),o=!0,n!==`h264enc-striped`&&cs(),Tc(),Ec(),setTimeout(()=>{if(u&&u.readyState===WebSocket.OPEN)try{u.send(`REQUEST_KEYFRAME`),Mi.keyframes++}catch{}},1500))}if(e.video_crf!==void 0&&(ni=parseInt(e.video_crf,10),r(`video_crf`,ni),o=!0),e.video_fullcolor!==void 0&&(ri=!!e.video_fullcolor,i(`video_fullcolor`,ri),o=!0,cs()),e.video_10bit!==void 0&&(ii=!!e.video_10bit,i(`video_10bit`,ii),o=!0),e.video_streaming_mode!==void 0&&(ui=!!e.video_streaming_mode,i(`video_streaming_mode`,ui),o=!0),e.jpeg_quality!==void 0&&(di=parseInt(e.jpeg_quality,10),r(`jpeg_quality`,di),o=!0),e.paint_over_jpeg_quality!==void 0&&(_i=parseInt(e.paint_over_jpeg_quality,10),r(`paint_over_jpeg_quality`,_i),o=!0),e.use_cpu!==void 0&&(yi=!!e.use_cpu,i(`use_cpu`,yi),o=!0,cs()),e.cpu_encode_threading!==void 0&&(xi=!!e.cpu_encode_threading,i(`cpu_encode_threading`,xi),t||rt.add(`cpu_encode_threading`),o=!0),e.video_paintover_crf!==void 0&&(Si=parseInt(e.video_paintover_crf,10),r(`video_paintover_crf`,Si),o=!0),e.video_paintover_burst_frames!==void 0&&(Ci=parseInt(e.video_paintover_burst_frames,10),r(`video_paintover_burst_frames`,Ci),o=!0),e.use_paint_over_quality!==void 0&&(wi=!!e.use_paint_over_quality,i(`use_paint_over_quality`,wi),t||rt.add(`use_paint_over_quality`),o=!0),e.scaling_dpi!==void 0&&(sn=parseInt(e.scaling_dpi,10),o=!0,H&&!window.manual_resolution&&!W&&typeof Rt==`function`&&Rt()),e.enable_binary_clipboard!==void 0&&(Kn=!!e.enable_binary_clipboard,i(`enable_binary_clipboard`,Kn),o=!0),e.keyboard_shortcuts!==void 0&&(Bn=!!e.keyboard_shortcuts,i(`keyboard_shortcuts`,Bn),Vn()),e.clipboard_seamless!==void 0&&(wn=!!e.clipboard_seamless,i(`clipboard_seamless`,wn)),e.print_auto!==void 0&&(ba.setAutomatic(e.print_auto),i(`print_auto`,!!e.print_auto)),e.clipboard_in_enabled!==void 0&&(xn=!!e.clipboard_in_enabled,i(`clipboard_in_enabled`,xn),o=!0),e.clipboard_out_enabled!==void 0&&(Cn=!!e.clipboard_out_enabled,i(`clipboard_out_enabled`,Cn),o=!0),e.use_css_scaling!==void 0){let n={type:`setUseCssScaling`,value:!!e.use_css_scaling,persist:!t};uc({origin:window.location.origin,data:n})}if(e.use_browser_cursors!==void 0&&(Tn=!!e.use_browser_cursors,Dn()),e.raw_pointer_motion!==void 0&&(On=!!e.raw_pointer_motion,An()),e.mac_cmd_as_ctrl!==void 0&&(Fn=!!e.mac_cmd_as_ctrl,Ln()),e.debug!==void 0){Gi=e.debug,oa(`debug`,Gi),console.log(`Applied debug setting: ${Gi}. Reloading...`),setTimeout(()=>{window.location.reload()},700);return}e.rate_control_mode!==void 0&&(ta=e.rate_control_mode,a(`rate_control_mode`,ta),gc(ta),o=!0),e.video_bitrate!==void 0&&(Ei=parseInt(e.video_bitrate,10),r(`video_bitrate`,Ei),t||Me(j),o=!0),e.audio_bitrate!==void 0&&(Ti=parseInt(e.audio_bitrate,10),r(`audio_bitrate`,Ti),o=!0),e.force_aligned_resolution!==void 0&&(Di=!!e.force_aligned_resolution,i(`force_aligned_resolution`,Di),o=!0),o&&n&&Jo(`handleSettingsMessage`,t?null:Object.keys(e))}function hc(e){if(W)return;let t=Xr(aa,G,e,yr(`the settings of a display it shares`));if(Object.keys(t).length!==0){console.log(`[display] Streaming with what the display does:`,t);for(let[e,n]of Object.entries(t))window[e]=n;mc(t,!0,!1),t.encoder!==void 0&&Ko(t.encoder,Je&&Je.encoder),Je&&window.postMessage({type:`serverSettings`,payload:{...Je}},window.location.origin)}}function gc(e){e===`cbr`?Ei=na(`video_bitrate`,Ei):e===`crf`&&(ni=na(`video_crf`,ni))}function _c(){let e={info:window.stream_info,client:window.stream_client,latest:window.stream_stats.latest,clientFps:window.fps,audioBuffer:window.currentAudioBufferSize,audioUnderrunSamples:window.currentAudioUnderrunSamples,audioDropped:window.currentAudioDropped+window.currentAudioWorkletDropped,isVideoPipelineActive:S,isAudioPipelineActive:w,isMicrophoneActive:T,isWebcamActive:Ne};e.encoderName=V,e.video_fullcolor=ri,e.video_10bit=ii,e.video_streaming_mode=ui,window.parent.postMessage({type:`stats`,data:e},window.location.origin),console.log(`Sent stats message via window.postMessage:`,e)}function vc(){if(!Kc())return;W||(window.displayRefreshRate=null,Wr=Ur(e=>{window.displayRefreshRate=e,window.postMessage({type:`displayRefresh`,rate:e},window.location.origin),Zo(`display refresh`)}));let a=Ee()+`/`;ir=tn({isChromium:qn,getDeferredWriteInFlight:()=>Yn.getInFlight(),isSharedMode:()=>W,canSync:()=>!!window.clipboard_enabled&&wn,canRead:()=>!!xn,binaryEnabled:()=>!!Kn,sendClipboardData:(e,t,n)=>pc(e,t,n),clipboardSync:Jn});let o=()=>ir.readAndSend(),ee=()=>ir.maybeInitial();qn&&window.addEventListener(`focus`,()=>{o()}),un({isChromium:qn,clipboardSync:Jn,sendClipboardData:(e,t)=>pc(e,t),canSync:()=>!W&&!!window.clipboard_enabled&&wn,canRead:()=>!!xn,canWrite:()=>!!Cn,binaryEnabled:()=>!!Kn,getSendInFlight:()=>ir.getSendInFlight(),getDeferredWriteLanding:()=>Yn.getLanding(),hasPendingServerWrite:()=>Yn.hasPending(),readLocalClipboard:o}).wire();let oe=()=>{if(l&&c)try{l.setTransform(1,0,0,1,0,0),l.clearRect(0,0,c.width,c.height)}catch(e){console.error(`Error clearing canvas on visibility change:`,e)}},y=null,b=!1,x=()=>{if(u&&u.readyState===WebSocket.OPEN&&S&&(u.send(`STOP_VIDEO`),S=!1,b=!0,window.postMessage({type:`pipelineStatusUpdate`,video:!1},window.location.origin),console.log(`Tab hidden: Sent STOP_VIDEO. Clearing canvas visually. Server will send PIPELINE_RESETTING for full state reset.`),l&&c))try{l.setTransform(1,0,0,1,0,0),l.clearRect(0,0,c.width,c.height)}catch(e){console.error(`Error clearing canvas on tab hidden:`,e)}};document.addEventListener(`visibilitychange`,async()=>{if(W){if(!u||u.readyState!==WebSocket.OPEN)return;if(document.hidden){if(!fr){fr=!0;try{u.send(`STOP_VIDEO`)}catch{}oe(),window.postMessage({type:`pipelineStatusUpdate`,video:!1},window.location.origin),console.log(`Shared mode: tab hidden, sent STOP_VIDEO to pause this viewer's feed.`)}}else{if(fr){fr=!1;try{u.send(`START_VIDEO`)}catch{}Ls(),window.postMessage({type:`pipelineStatusUpdate`,video:!0},window.location.origin),console.log(`Shared mode: tab visible, sent START_VIDEO to resume this viewer's feed.`)}Gt===null&&(console.log(`Tab is visible again, re-acquiring Wake Lock.`),await Ks())}return}if(document.hidden)y===null&&(y=setTimeout(()=>{y=null,document.hidden&&(console.log(`Tab is hidden, stopping video pipeline if active.`),x())},250));else{if(y!==null&&(clearTimeout(y),y=null),!b&&S&&Fs(),b&&(b=!1,console.log(`Tab is visible, resuming the video pipeline paused on hide.`),u&&u.readyState===WebSocket.OPEN&&(u.send(`START_VIDEO`),S=!0,Ls(),window.postMessage({type:`pipelineStatusUpdate`,video:!0},window.location.origin),console.log(`Tab visible: Sent START_VIDEO. Clearing canvas visually. Server will send PIPELINE_RESETTING for full state reset.`),l&&c)))try{l.setTransform(1,0,0,1,0,0),l.clearRect(0,0,c.width,c.height)}catch(e){console.error(`Error clearing canvas on tab visible/start:`,e)}Gt===null&&(console.log(`Tab is visible again, re-acquiring Wake Lock.`),await Ks())}});let se={imagedecoder:async e=>{let t=new ImageDecoder({data:e,type:`image/jpeg`});try{return(await t.decode()).image}finally{try{t.close()}catch{}}},bitmap:e=>createImageBitmap(new Blob([e],{type:`image/jpeg`})),img:e=>{let t=URL.createObjectURL(new Blob([e],{type:`image/jpeg`})),n=new Image;return n.src=t,n.decode().then(()=>n,e=>{throw URL.revokeObjectURL(t),e}).then(e=>(URL.revokeObjectURL(t),e))}};function ce(e,t){let n=new TextEncoder().encode(`sel`+t.toString(36).padStart(9,`0`)),r=new Uint8Array(e),i=new Uint8Array(r.length+4+n.length);i[0]=255,i[1]=216,i[2]=255,i[3]=254;let a=n.length+2;return i[4]=a>>8&255,i[5]=a&255,i.set(n,6),i.set(r.subarray(2),6+n.length),i}let ue=null,fe=null;async function me(){let e=Object.keys(se).filter(e=>(e!==`imagedecoder`||typeof ImageDecoder<`u`)&&(e!==`bitmap`||typeof createImageBitmap==`function`)&&(e!==`img`||typeof Image<`u`));if(e.length<=1)return e[0]||null;let t=1920,n,r;try{n=[];for(let e=0;e<8;e++){let r=document.createElement(`canvas`);r.width=t,r.height=136;let i=r.getContext(`2d`);i.fillStyle=`#204080`,i.fillRect(0,0,t,136),i.lineWidth=3,i.strokeStyle=`#c8c828`;for(let n=0;n<t;n+=40)i.beginPath(),i.moveTo(n+e,0),i.lineTo(n+e,136),i.stroke();let a=await new Promise(e=>r.toBlob(e,`image/jpeg`,.75));n.push(await a.arrayBuffer())}r=document.createElement(`canvas`),r.width=t,r.height=1088}catch{return e[0]}let i=r.getContext(`2d`),a=0;for(let t of e)try{let e=await se[t](ce(n[0],a++));i.drawImage(e,0,0);try{e.close()}catch{}}catch{}let o=null;for(let t of e)try{let e=performance.now();for(let e=0;e<2;e++)await Promise.all(n.map(async(e,n)=>{let r=await se[t](ce(e,a++));i.drawImage(r,0,n*136);try{r.close()}catch{}}));let r=performance.now()-e;(!o||r<o.ms)&&(o={name:t,ms:r})}catch{}return o?o.name:e[0]}async function he(e,t,n,r){Ce++;try{let i=ue;if(!i&&(fe||=me().then(e=>(ue=e,e&&console.log(`[jpeg] decoding stripes through ${e}`),e)).catch(()=>null),i=typeof ImageDecoder<`u`?`imagedecoder`:typeof createImageBitmap==`function`?`bitmap`:null,!i)){console.warn(`No JPEG decoder available (ImageDecoder and createImageBitmap both missing).`);return}Se.push({image:await se[i](t),startY:e,frameId:n,at:r}),_e()}catch(n){console.error(`Error decoding JPEG stripe:`,n,`startY:`,e,`dataLength:`,t.byteLength)}finally{Ce--}}let ge=!1;function _e(){ge||(ge=!0,requestAnimationFrame(()=>{ge=!1,ve()}))}ps=_e;function ve(){if(!c||!l){_e();return}if(le||ka){let e=qt(V);le&&!e&&yo(),ka&&!e&&!Ha&&fo()}let e=W?1:window.devicePixelRatio||1;if(W&&z&&B&&z>0&&B>0){let t=Q(z*e),n=Q(B*e);(c.width!==t||c.height!==n)&&(console.log(`Shared mode (paintVideoFrame): Canvas buffer ${c.width}x${c.height} out of sync with expected physical ${t}x${n} (logical: ${z}x${B}). Re-applying style.`),ts(z,B,!0))}let t=!1;if(qt(V)){let e=!1;if(fs.length>0){let t=fs.length-1;for(let e=0;e<t;e++)try{fs[e].frame.close()}catch{}J.open&&Ni.superseded(t);let n=fs[t].frame;if(fs.length=0,Be=performance.now(),!(Ta&&ro(n))&&!(Ea&&mo(n))){c.width>0&&c.height>0&&(l.drawImage(n,0,0),J.open&&Ni.drawn(Li(n.timestamp)));try{n.close()}catch{}}e=!0}e&&!Ki&&nc()}else if(V===`h264enc-striped`){Ea&&!$&&!Va&&qa<3&&uo();let e=!1,t=ks(),n=us(),r=n&&bs.settled(),i=!1;if(t)for(let t of fs){let n=t.frameId;!r&&gs!==null&&n!==gs&&_s&&(js(),_s=!1,e=!0),gs=n,t.yPos+t.frame.displayHeight>=c.height&&(i=!0),As(t.frame,t.yPos),t.at>Ms&&(Ms=t.at),_s=!0}else for(let e of fs)try{e.frame.close()}catch{}fs=[],n&&(r||i)&&_s&&c.width>0&&c.height>0&&(js(),_s=!1,e=!0),e&&!Ki&&nc()}else if(V===`jpeg`){Ea&&!$&&!Va&&qa<3&&uo();let e=Ce===0,n=e&&bs.settled(),r=!1;if(l&&Se.length>0){if(c.width===0||c.height===0||c.width===300&&c.height===150){let e=Se[0],t=e&&e.image&&(e.image.displayHeight??e.image.height),n=e&&e.image&&(e.image.displayWidth??e.image.width);e&&e.image&&(e.startY+t>c.height||n>c.width)&&console.warn(`[paintVideoFrame] Canvas dimensions (${c.width}x${c.height}) may be too small for JPEG stripes.`)}let e=ks();for(;Se.length>0;){let i=Se.shift();if(i&&i.image){let a=i.frameId,o=Ns[i.startY];if(a!==void 0&&o!==void 0){let e=o-a&65535;if(e>0&&e<=256){try{i.image.close()}catch{}continue}}try{if(e){!n&&a!==void 0&&gs!==null&&a!==gs&&_s&&(js(),_s=!1),a!==void 0&&(gs=a);let e=i.image.displayHeight??i.image.height;i.startY+e>=c.height&&(r=!0),As(i.image,i.startY),i.at>Ms&&(Ms=i.at),_s=!0}else try{i.image.close()}catch{}a!==void 0&&(Ns[i.startY]=a),t=!0}catch(e){if(console.error(`[paintVideoFrame] Error drawing JPEG segment:`,e,i),i.image&&typeof i.image.close==`function`)try{i.image.close()}catch{}}}}t&&(Ki||(nc(),!Ji&&!W&&rc()))}e&&(n||r)&&_s&&l&&c.width>0&&c.height>0&&(js(),_s=!1)}J.open&&Ni.land(),(fs.length>0||Se.length>0||_s)&&_e()}function ye(){if(!s||!v)return;let e=new MessageChannel;try{v.postMessage({type:`pcmPort`,port:e.port1},[e.port1]),s.postMessage({type:`pcmPort`,port:e.port2},[e.port2])}catch(e){console.warn(`Could not connect the audio decoder to the worklet directly:`,e)}}function be(){if(!s||!u||typeof u.connectAudio!=`function`)return;let e=new MessageChannel;try{s.postMessage({type:`audioIn`,port:e.port1},[e.port1]),u.connectAudio(e.port2)}catch(e){console.warn(`Could not connect the socket worker to the audio decoder:`,e)}}let xe=`
let ws = null, audioPort = null, audioOn = true, primary = true;
let lastTick = 0;

// Encoded webcam frames sent while the socket was down would corrupt the
// server's decoder as deltas; held back until a keyframe restores the chain.
let webcamChainBroken = false;
// Video divert: 0x03/0x04 go straight to the video worker while the page
// keeps this on, and the newest frame id is acked from here on the same
// cadence the page would use, so pacing and RTT stay honest through a stall.
// Full frames ack on receipt; the striped modes ack the id the video worker
// reports presented, so a client that cannot render sheds load. An unchanged
// id is repeated on the heartbeat cadence, as the page path does.
let videoPort = null, videoDivert = false, videoAck = false, videoAckSource = 'receive';
let videoLastId = -1, videoLastIdAt = 0, videoAckedId = -1, videoAckSentAt = 0, videoAckTimer = null;
// While the page has its stats open, each message is dated with its arrival
// (epoch ms), which the thread that shows a frame measures its delay from.
let statsOn = false;

// The page gates its own sends on what this reports, so a socket left holding
// bytes has to be reported as it drains: reporting only on send would freeze
// the page's view at the moment of a message too big for its gate, and nothing
// would ever send again to correct it.
let bufferedTimer = null;
function reportBuffered() {
  self.postMessage({ type: 'buffered', amount: ws ? ws.bufferedAmount : 0 });
  if (!ws || ws.bufferedAmount === 0) {
    if (bufferedTimer) { clearInterval(bufferedTimer); bufferedTimer = null; }
    return;
  }
  if (bufferedTimer) return;
  bufferedTimer = setInterval(() => {
    self.postMessage({ type: 'buffered', amount: ws ? ws.bufferedAmount : 0 });
    if (!ws || ws.bufferedAmount === 0) { clearInterval(bufferedTimer); bufferedTimer = null; }
  }, 20);
}

function syncVideoAckTimer() {
  const want = videoDivert && videoAck;
  if (want && !videoAckTimer) {
    videoAckTimer = setInterval(() => {
      if (videoLastId < 0) return;
      if (!ws || ws.readyState !== 1) return;
      const now = performance.now();
      if (videoLastId === videoAckedId && now - videoAckSentAt < ${Pt}) return;
      // The hold: how long the id waited on this tick, which a backgrounded
      // tab clamps to a second. The server subtracts it, so the round trip it
      // reports stays the path's rather than this timer's.
      const held = Math.max(0, Math.round(now - videoLastIdAt));
      try { ws.send('CLIENT_FRAME_ACK ' + videoLastId + ' ' + held); videoAckedId = videoLastId; videoAckSentAt = now; } catch (err) {}
    }, 50);
  } else if (!want && videoAckTimer) {
    clearInterval(videoAckTimer);
    videoAckTimer = null;
  }
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'audioPort') { audioPort = m.port; return; }
  if (m.type === 'audioState') { audioOn = !!m.active; return; }
  if (m.type === 'videoPort') {
    videoPort = m.port;
    videoPort.onmessage = (ev) => {
      const pm = ev.data;
      if (pm && pm.presentedId !== undefined) { videoLastId = pm.presentedId; videoLastIdAt = performance.now(); }
    };
    return;
  }
  if (m.type === 'videoState') {
    videoDivert = !!m.divert;
    videoAck = !!m.ack;
    videoAckSource = m.ackSource || 'receive';
    syncVideoAckTimer();
    return;
  }
  if (m.type === 'stats') { statsOn = !!m.on; return; }
  if (m.type === 'videoAckReset') {
    // The server's ids restart; the heartbeat must not repeat the old one.
    videoLastId = -1; videoAckedId = -1; videoAckSentAt = 0;
    return;
  }
  if (m.type === 'sendPort') {
    // Fully framed messages from another worker (the microphone encoder).
    m.port.onmessage = (ev) => {
      if (!ws || ws.readyState !== 1) return;
      try { ws.send(ev.data); } catch (err) { /* onclose reports */ }
    };
    return;
  }
  if (m.type === 'webcamPort') {
    m.port.onmessage = (ev) => {
      const f = ev.data;
      if (!ws || ws.readyState !== 1) { webcamChainBroken = true; return; }
      if (webcamChainBroken && !f.keyframe) {
        try { ev.target.postMessage({ needKeyframe: true }); } catch (err) {}
        return;
      }
      const msg = new Uint8Array(3 + f.buffer.byteLength);
      msg[0] = 0x06;
      msg[1] = f.codecId;
      msg[2] = (f.keyframe ? 0x01 : 0x00) | ((((f.rotation || 0) / 90) & 0x03) << 1) | (f.flip ? 0x08 : 0x00);
      msg.set(new Uint8Array(f.buffer), 3);
      try {
        ws.send(msg.buffer);
        if (f.keyframe) webcamChainBroken = false;
      } catch (err) { webcamChainBroken = true; }
    };
    return;
  }
  if (m.type === 'open') {
    primary = m.primary !== false;
    try {
      ws = new WebSocket(m.url, m.protocols || []);
    } catch (err) {
      // Uncaught here, the page would wait on a socket that never opens.
      self.postMessage({ type: 'close', code: 1006, reason: '', wasClean: false });
      return;
    }
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => self.postMessage({ type: 'open' });
    ws.onerror = () => self.postMessage({ type: 'error' });
    ws.onclose = (ev) => {
      self.postMessage({ type: 'close', code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
      ws = null;
    };
    ws.onmessage = (ev) => {
      const d = ev.data;
      const at = statsOn ? performance.timeOrigin + performance.now() : 0;
      if (audioPort && audioOn && primary && d instanceof ArrayBuffer &&
          d.byteLength >= 2 && new Uint8Array(d, 0, 1)[0] === 0x01) {
        // The page still owns the AudioContext, which only it can resume, so it
        // is told audio is arriving -- rarely, since this runs per packet.
        const now = Date.now();
        if (now - lastTick > 1000) { lastTick = now; self.postMessage({ type: 'audioTick' }); }
        audioPort.postMessage({ buffer: d }, [d]);
        return;
      }
      if (videoPort && videoDivert && d instanceof ArrayBuffer && d.byteLength > 6) {
        const t = new Uint8Array(d, 0, 1)[0];
        if (t === 0x03 || (t === 0x04 && d.byteLength > 10)) {
          if (videoAckSource === 'receive') {
            const head = new Uint8Array(d, 2, 2);
            videoLastId = (head[0] << 8) | head[1];
            videoLastIdAt = performance.now();
          }
          if (at) videoPort.postMessage({ buffer: d, at }, [d]);
          else videoPort.postMessage(d, [d]);
          return;
        }
      }
      if (d instanceof ArrayBuffer) self.postMessage({ type: 'message', data: d, at }, [d]);
      else self.postMessage({ type: 'message', data: d });
    };
    return;
  }
  if (!ws) return;
  if (m.type === 'send') {
    try { ws.send(m.data); } catch (err) { /* a closing socket reports through onclose */ }
    reportBuffered();
    return;
  }
  if (m.type === 'close') { try { ws.close(m.code, m.reason); } catch (err) {} return; }
};
`;class we{constructor(e,t,n=[]){this.readyState=WebSocket.CONNECTING,this.binaryType=`arraybuffer`,this.onopen=this.onmessage=this.onerror=this.onclose=null,this._listeners={},this._buffered=0;let r=new Blob([xe],{type:`text/javascript`}),i=URL.createObjectURL(r);this._worker=new Worker(i),URL.revokeObjectURL(i),this._worker.onmessage=e=>{let t=e.data;if(t.type===`message`){let e={data:t.data,at:t.at};this.onmessage&&this.onmessage(e),this._emit(`message`,e);return}if(t.type===`buffered`){this._buffered=t.amount;return}if(t.type===`audioTick`){h&&h.state!==`running`&&h.resume().catch(()=>{});return}if(t.type===`open`){this.readyState=WebSocket.OPEN,this.onopen&&this.onopen(),this._emit(`open`,{});return}if(t.type===`error`){this.onerror&&this.onerror(t),this._emit(`error`,t);return}if(t.type===`close`){this.readyState=WebSocket.CLOSED,this.onclose&&this.onclose(t),this._emit(`close`,t),this._retire();return}},this._worker.postMessage({type:`open`,url:e,primary:t,protocols:n})}get bufferedAmount(){return this._buffered}addEventListener(e,t){(this._listeners[e]||(this._listeners[e]=[])).push(t)}removeEventListener(e,t){let n=this._listeners[e];if(!n)return;let r=n.indexOf(t);r>=0&&n.splice(r,1)}_emit(e,t){let n=this._listeners[e];if(n)for(let e of n.slice())try{e(t)}catch{}}connectAudio(e){try{this._worker.postMessage({type:`audioPort`,port:e},[e])}catch{}}setAudioActive(e){try{this._worker.postMessage({type:`audioState`,active:e})}catch{}}connectSend(e){try{this._worker.postMessage({type:`sendPort`,port:e},[e])}catch{}}connectWebcam(e){try{this._worker.postMessage({type:`webcamPort`,port:e},[e])}catch{}}connectVideo(e){try{this._worker.postMessage({type:`videoPort`,port:e},[e])}catch{}}setVideoDivert(e,t){let n=!!e&&j===`primary`&&!W;try{this._worker.postMessage({type:`videoState`,divert:!!e,ack:n,ackSource:t||`receive`})}catch{}}setStats(e){try{this._worker.postMessage({type:`stats`,on:!!e})}catch{}}resetVideoAck(){try{this._worker.postMessage({type:`videoAckReset`})}catch{}}send(e){if(this.readyState!==WebSocket.OPEN)return;if(typeof e==`string`){this._buffered+=e.length,this._worker.postMessage({type:`send`,data:e});return}let t=e instanceof ArrayBuffer?e:ArrayBuffer.isView(e)?e.buffer.slice(e.byteOffset,e.byteOffset+e.byteLength):e;this._buffered+=t.byteLength||0,this._worker.postMessage({type:`send`,data:t},[t])}close(e,t){this.readyState=WebSocket.CLOSING;try{this._worker.postMessage({type:`close`,code:e,reason:t})}catch{}this._retire()}_retire(){this._retiring||(this._retiring=!0,setTimeout(()=>{try{this._worker.terminate()}catch{}},2e3))}}async function Te(){if(j!==`primary`){console.log(`Secondary display: Audio pipeline initialization skipped.`);return}if(!window.isAudioInitializing){if(s&&h&&h.state!==`closed`&&g)return be(),!0;window.isAudioInitializing=!0;try{if(s){console.warn(`Terminating existing audio worker during init.`);let e=s;s=null,e.postMessage({type:`close`}),await new Promise(e=>setTimeout(e,50)),e.terminate()}if(h){console.warn(`Closing existing AudioContext during init.`);try{await h.close()}catch(e){console.error(e)}h=null,ac(),g=null,v=null}h||(navigator.audioSession&&navigator.audioSession.type===`play-and-record`||Nc(`playback`),h=new(window.AudioContext||window.webkitAudioContext)({sampleRate:48e3}),console.log(`Playback AudioContext initialized. Actual sampleRate:`,h.sampleRate,`Initial state:`,h.state),h.onstatechange=()=>{h&&(console.log(`Playback AudioContext state changed to: ${h.state}`),h.state===`running`&&oc())});try{await h.audioWorklet.addModule(R(`
        class AudioFrameProcessor extends AudioWorkletProcessor {
            constructor(options) {
                super();
                this.channels = (options && options.processorOptions && options.processorOptions.channels) || 2;
                this.audioBufferQueue = [];
                this.currentAudioData = null;
                this.currentDataOffset = 0;

                // Adaptive jitter depth under a fixed drop-oldest ceiling.
                // Output starts once target packets are queued; a mid-stream
                // underrun that a late delivery caused deepens the target, a
                // clean stretch decays it back, and standing depth above it is
                // trimmed a packet at a time -- so steady latency sits at the
                // smallest depth the delivery path has recently proven to
                // hold, and a jittery one (a stall upstream, Gecko routing
                // the socket through the page's thread) buys the depth it
                // demonstrably needs. The depths are durations counted in
                // packets of the frame duration the stream carries (see
                // _learnFrame), so they mean the same at every setting.
                this.frameSamples = 0;
                this._learnFrame(480);
                this.target = this.TARGET_MIN;
                this.priming = true;
                this.overCount = 0;
                this.cleanCount = 0;
                // Packets left at the moment one is pulled, tracked at its
                // minimum: the slack that proves a shallower target safe.
                // Pulls since the last arrival are held apart and committed
                // by the next one, unless the sender went quiet between them,
                // since a drain into its silence proves nothing about the
                // delivery.
                this.shiftSlackMin = Infinity;
                this.drainSlackMin = Infinity;
                // The server says when its silence gate closes (a bare quiet
                // mark): what is queued then plays out at once, however short,
                // instead of waiting for packets that are not coming, and
                // running dry after it is the sender's silence. An underrun is
                // judged by what ends it, since the mark can trail the last
                // packet by up to a frame: a packet means a late delivery,
                // which deepens the target, and the mark means silence. The
                // frame the server sends right behind the mark, carrying the
                // end of the sound, is marked too (\`ending\`): it is appended
                // to the sound, and whatever it ends is silence as well.
                this.senderQuiet = false;
                this.underrunPending = false;
                this.pendingUnderrunSamples = 0;

                // Concealment counters: zero-filled samples output on underrun, and
                // packets dropped by the drop-oldest ring when the queue overflows.
                this.underrunSamples = 0;
                this.droppedOldest = 0;
                // Every seam is smoothed over 2 ms: output fades in when priming
                // ends, the last sample decays to silence when the queue runs
                // dry, and a dropped packet's head is blended into the head of
                // the one after it -- a step at any of them is a click on tonal
                // content.
                this.FADE = Math.round(sampleRate * 0.002);
                this.fadeIn = 0;
                this.fadeOut = 0;
                this.lastOut = new Float32Array(Math.max(this.channels, 8));
                // Output RMS accumulator (channel 0), reported with each stats reply.
                this._levelAcc = 0;
                this._levelCount = 0;

                this.enqueue = (buffer, ending) => {
                    const pcmData = new Float32Array(buffer);
                    this._learnFrame(pcmData.length / this.channels);
                    if (ending) {
                        this.underrunPending = false;
                        this.pendingUnderrunSamples = 0;
                        this.senderQuiet = true;
                    } else {
                        if (this.underrunPending) {
                            this.underrunPending = false;
                            this.target = Math.min(this.target + this.STEP, this.TARGET_MAX);
                            this.underrunSamples += this.pendingUnderrunSamples;
                            this.pendingUnderrunSamples = 0;
                            this.cleanCount = 0;
                            this.shiftSlackMin = Infinity;
                            this.drainSlackMin = Infinity;
                        }
                        if (this.senderQuiet) this.senderQuiet = false;
                        else if (this.drainSlackMin < this.shiftSlackMin) this.shiftSlackMin = this.drainSlackMin;
                    }
                    this.drainSlackMin = Infinity;
                    if (this.audioBufferQueue.length >= this.MAX_BUFFER_PACKETS) this._dropHead();
                    this.audioBufferQueue.push(pcmData);
                };
                const receive = (data) => {
                    if (!data) return;
                    if (data.audioData) {
                        this.enqueue(data.audioData, !!data.quiet);
                    } else if (data.quiet) {
                        this.senderQuiet = true;
                        this.underrunPending = false;
                        this.pendingUnderrunSamples = 0;
                    }
                };
                this.port.onmessage = (event) => {
                    if (event.data.audioData || event.data.quiet) {
                        receive(event.data);
                    } else if (event.data.type === 'pcmPort' && event.data.port) {
                        // The decoder worker's own line in: decoded packets then
                        // reach this processor whatever the page's thread is doing.
                        event.data.port.onmessage = (m) => receive(m.data);
                    } else if (event.data.type === 'getBufferSize') {
                        const bufferMillis = this.audioBufferQueue.reduce((total, buf) => total + (buf.length / this.channels / sampleRate) * 1000, 0);
                        const level = this._levelCount > 0 ? Math.sqrt(this._levelAcc / this._levelCount) : 0;
                        this._levelAcc = 0;
                        this._levelCount = 0;
                        this.port.postMessage({
                            type: 'audioBufferSize',
                            size: this.audioBufferQueue.length,
                            durationMs: bufferMillis,
                            underrunSamples: this.underrunSamples,
                            droppedOldest: this.droppedOldest,
                            level: level
                        });
                    }
                };
            }

            process(inputs, outputs, parameters) {
                const output = outputs[0];
                if (!output || !output[0]) {
                    return true;
                }
                // The decoder hands interleaved f32 data with this.channels channels;
                // de-interleave into however many output channels were configured.
                const chans = output.length;
                const samplesPerBuffer = output[0].length;

                if (this.priming) {
                    const held = this.audioBufferQueue.length;
                    if (held < this.target && !(this.senderQuiet && held > 0)) {
                        this._silence(output, 0);
                        return true;
                    }
                    this.priming = false;
                    this.fadeIn = this.FADE;
                    this.fadeOut = 0;
                }

                if (this.audioBufferQueue.length === 0 && this.currentAudioData === null) {
                    this.fadeOut = this.FADE;
                    this._silence(output, 0);
                    // Full-buffer concealment.
                    this._reprime(samplesPerBuffer);
                    return true;
                }

                let data = this.currentAudioData;
                let offset = this.currentDataOffset;

                for (let sampleIndex = 0; sampleIndex < samplesPerBuffer; sampleIndex++) {
                    if (!data || offset >= data.length) {
                        if (this.audioBufferQueue.length > 0) {
                            const slack = this.audioBufferQueue.length - 1;
                            if (slack < this.drainSlackMin) this.drainSlackMin = slack;
                            data = this.currentAudioData = this.audioBufferQueue.shift();
                            offset = this.currentDataOffset = 0;
                        } else {
                            this.currentAudioData = null;
                            this.currentDataOffset = 0;
                            this.fadeOut = this.FADE;
                            this._silence(output, sampleIndex);
                            // Partial concealment.
                            this._reprime(samplesPerBuffer - sampleIndex);
                            return true;
                        }
                    }

                    const gain = this.fadeIn > 0 ? (this.FADE - this.fadeIn-- + 1) / (this.FADE + 1) : 1;
                    for (let c = 0; c < chans; c++) {
                        const v = offset < data.length ? data[offset++] * gain : output[0][sampleIndex];
                        output[c][sampleIndex] = v;
                        this.lastOut[c] = v;
                    }
                    const s0 = output[0][sampleIndex];
                    this._levelAcc += s0 * s0;
                    this._levelCount++;
                }

                this.currentDataOffset = offset;
                if (data && offset >= data.length) {
                    this.currentAudioData = null;
                    this.currentDataOffset = 0;
                }

                // Reclaims latency: depth held above target is a standing
                // delay, dropped one packet per window; long clean runs
                // shrink the target.
                if (this.audioBufferQueue.length > this.target) {
                    if (++this.overCount >= 250) {
                        this._dropHead();
                        this.overCount = 0;
                    }
                } else {
                    this.overCount = 0;
                }
                if (++this.cleanCount >= 2000) {
                    this.cleanCount = 0;
                    // Decay only over proven slack: a whole packet must have
                    // stayed spare at every pull, else a shallower target is
                    // a periodic audible probe rather than a reclaim.
                    if (this.target > this.TARGET_MIN && this.shiftSlackMin >= 2 * this.STEP) {
                        this.target = Math.max(this.TARGET_MIN, this.target - this.STEP);
                    }
                    this.shiftSlackMin = Infinity;
                }

                return true;
            }

            /**
             * Writes silence from \`from\` on, after the rest of a fade-out:
             * the last sample output decaying to zero over the fade.
             * @param {Float32Array[]} output The quantum's output channels.
             * @param {number} from First sample to write.
             */
            _silence(output, from) {
                const n = output[0].length;
                let k = from;
                for (; k < n && this.fadeOut > 0; k++, this.fadeOut--) {
                    const g = this.fadeOut / (this.FADE + 1);
                    for (let c = 0; c < output.length; c++) output[c][k] = this.lastOut[c] * g;
                }
                for (let c = 0; c < output.length; c++) output[c].fill(0, k);
            }

            /**
             * Drops the oldest queued packet, blending its head into the head
             * of the packet after it: the dropped head continues whatever
             * played before it, so the seam starts where the audio left off.
             */
            _dropHead() {
                const gone = this.audioBufferQueue.shift();
                this.droppedOldest++;
                const next = this.audioBufferQueue[0];
                if (!gone || !next) return;
                const ch = this.channels;
                const frames = Math.min(this.FADE, gone.length / ch, next.length / ch);
                for (let f = 0; f < frames; f++) {
                    const w = (f + 1) / (frames + 1);
                    for (let c = 0; c < ch; c++) {
                        const i = f * ch + c;
                        next[i] = gone[i] + (next[i] - gone[i]) * w;
                    }
                }
            }

            /**
             * Restarts priming after the queue ran dry: after the quiet mark
             * that is the sender's silence, otherwise what ends it says
             * whether the target deepens.
             * @param {number} samples Samples zero-filled when it ran dry.
             */
            _reprime(samples) {
                this.priming = true;
                this.overCount = 0;
                if (this.senderQuiet) return;
                this.underrunPending = true;
                this.pendingUnderrunSamples += samples;
            }

            /**
             * Sizes the depths for packets of \`frames\` samples per
             * channel. A target of N packets starts output once N are
             * queued, which leaves N - 1 packets of arrival slack behind the
             * one playing, so the durations are slack: the target keeps its
             * floor of two packets, deepens and decays in steps of 5 ms, and
             * stops once 50 ms of slack is reached, with the drop-oldest
             * ceiling 20 ms above that, each rounded up to whole packets --
             * two, six, one, and eight at the default 10 ms frame.
             * @param {number} frames Samples per channel in one packet.
             */
            _learnFrame(frames) {
                if (!(frames > 0) || frames === this.frameSamples) return;
                this.frameSamples = frames;
                const ms = frames * 1000 / sampleRate;
                const packets = (d) => Math.max(1, Math.ceil(d / ms - 1e-9));
                this.TARGET_MIN = 2;
                this.TARGET_MAX = 1 + packets(50);
                this.STEP = packets(5);
                this.MAX_BUFFER_PACKETS = this.TARGET_MAX + packets(20);
                if (this.target !== undefined) {
                    this.target = Math.min(Math.max(this.target, this.TARGET_MIN), this.TARGET_MAX);
                }
            }
        }
        registerProcessor('audio-frame-processor', AudioFrameProcessor);
      `));let e=Oc();if(e>2)try{h.destination.channelCount=Math.min(e,h.destination.maxChannelCount||e)}catch(e){console.warn(`Could not widen audio destination:`,e)}g=new AudioWorkletNode(h,`audio-frame-processor`,{numberOfOutputs:1,outputChannelCount:[e],processorOptions:{channels:e}}),v=g.port,ye(),v.onmessage=e=>{e.data.type===`audioBufferSize`&&(window.currentAudioBufferSize=e.data.size,window.currentAudioBufferDuration=e.data.durationMs,e.data.underrunSamples!==void 0&&(window.currentAudioUnderrunSamples=e.data.underrunSamples),e.data.droppedOldest!==void 0&&(window.currentAudioWorkletDropped=e.data.droppedOldest),e.data.level!==void 0&&(window.currentAudioLevel=Math.min(100,Math.round(e.data.level*141))))},_=h.createGain(),_.gain.value=ne,g.connect(_),_.connect(h.destination),console.log(`Playback AudioWorkletProcessor initialized and connected through a GainNode for volume control.`),await oc();let t=new Blob([jc],{type:`application/javascript`}),n=URL.createObjectURL(t);if(s=new Worker(n),URL.revokeObjectURL(n),ye(),be(),s.onmessage=e=>{let{type:t,reason:n,message:r}=e.data;if(t===`decoderInitFailed`)console.error(`[Main] Audio Decoder Worker failed to initialize: ${n}`);else if(t===`decoderError`)console.error(`[Main] Audio Decoder Worker reported error: ${r}`);else if(t===`decoderInitialized`)console.log(e.data.wasm?`[Main] Audio Decoder Worker decodes on libopus in WASM, the engine having no AudioDecoder.`:`[Main] Audio Decoder Worker confirmed its decoder is initialized.`);else if(t===`decodedAudioData`){let t=e.data.pcmBuffer;t&&v&&h&&h.state===`running`&&window.currentAudioBufferDuration<80&&v.postMessage(e.data.quiet?{audioData:t,quiet:!0}:{audioData:t},[t])}else t===`audioQuiet`&&v&&v.postMessage({quiet:!0})},s.onerror=e=>{console.error(`[Main] Uncaught error in Audio Decoder Worker:`,e.message,e),s&&=(s.terminate(),null)},v){let e=Oc();s.postMessage({type:`init`,data:{initialPipelineStatus:w,channels:e,description:e>2?Ac(e):null,opusUrl:kc()}}),console.log(`[Main] Audio Decoder Worker created and init message sent.`)}else console.error(`[Main] audioWorkletProcessorPort is null, cannot initialize audioDecoderWorker correctly.`)}catch(e){console.error(`Error initializing Playback AudioWorklet:`,e),h&&h.state!==`closed`&&h.close(),h=null,ac(),g=null,v=null}}finally{window.isAudioInitializing=!1}}}async function De(){s?(console.log(`[Main] Requesting Audio Decoder Worker to reinitialize its decoder.`),s.postMessage({type:`reinitialize`})):(console.warn(`[Main] Cannot initialize decoder audio: Audio Decoder Worker not available. Call initializeAudio() first.`),d===`websockets`&&!h&&(console.log(`[Main] Audio context missing, attempting to initialize full audio pipeline for websockets.`),await Te()))}let Oe=location.protocol===`http:`?`ws://`:`wss://`,ke=new URL(`${Oe}${window.location.host}${a}`),Ae=yn();if(m)Ae.length===0&&(ke.search=`?token=${encodeURIComponent(lr)}`);else if(W){let e=new URLSearchParams;if(e.set(`role`,`viewer`),or&&or.startsWith(`player`)){let t=or.replace(`player`,``);t>=2&&t<=4&&e.set(`slot`,t)}ke.search=e.toString()}ke.pathname+=`api/websockets`;let Me=cr.get(`socket_worker`),D=Me===null?Z(`socket_worker`,!0):Me.toLowerCase()===`true`,Pe=()=>{try{if(!D)throw Error(`socket_worker=false`);u=new we(ke.href,j===`primary`,Ae),J.open&&u.setStats(!0)}catch(e){D&&console.warn(`[websockets] socket worker unavailable, reading on the page:`,e),u=new WebSocket(ke.href,Ae),u.binaryType=`arraybuffer`}window.selkiesTransport=u,be(),Ha=!1,ao()};Pe();let He=()=>{if(!Ha&&u&&u.readyState===WebSocket.OPEN)try{let e=(V===`jpeg`||V===`h264enc-striped`)&&vs!==null,t=e?vs:Ie,n=e?ys:O,r=performance.now();if(t!==-1&&t!==null&&(t!==Re||r-ze>=Pt)){let e=Math.max(0,Math.round(r-n));u.send(`CLIENT_FRAME_ACK ${t} ${e}`),Re=t,ze=r}}catch(e){console.error(`[Backpressure] Error sending frame ACK:`,e)}},Ue=()=>{if(v&&v.postMessage({type:`getBufferSize`}),Hi(),W)return;let e=performance.now(),t=e-Qi,n=e-$i,r=1e3,i=Zi.size+Wa;if(i>0){if(t>=r){let n=i*1e3/t;window.fps=Math.round(n),Zi.clear(),Wa=0,Qi=e,Xi=0,$i=e}}else if(Xi>0){if(n>=r){let t=Xi*1e3/n;window.fps=Math.round(t),Xi=0,$i=e,Qi=e}}else(t>=r||n>=r)&&(window.fps=0,$i=e,Qi=e);Rr(),zr()},at=async()=>{console.log(`[websockets] Connection opened!`),yt=performance.now(),vt=0,hi=!1,await Co(),await Eo(),await de===`avcc`&&console.info(`[Selkies] H.264 decodes here with an avcC description; frames are reframed for it.`),Cc().then(e=>{e&&location.reload()}),yc=!0;try{sessionStorage.removeItem(`selkies_mode_flip`)}catch{}if(Oi=`connected_waiting_mode`,ki=`Connection established. Waiting for server mode...`,wa(),typeof DecompressionStream<`u`)try{u.send(`_gz,1`)}catch{}if(window.postMessage({type:`trackpadModeUpdate`,enabled:an},window.location.origin),W)console.log(`Shared mode: WebSocket opened. Waiting for 'MODE websockets' from server to start identification sequence.`);else{let e=`${G}_`,t={},n=Zt(),r=[`video_crf`,`encoder`,`manual_resolution`,`audio_bitrate`,`video_fullcolor`,`video_10bit`,`video_streaming_mode`,`jpeg_quality`,`paint_over_jpeg_quality`,`use_cpu`,`cpu_encode_threading`,`video_paintover_crf`,`video_paintover_burst_frames`,`use_paint_over_quality`,`scaling_dpi`,`enable_binary_clipboard`,`rate_control_mode`,`video_bitrate`,`force_aligned_resolution`],i=[`manual_resolution`,`video_fullcolor`,`video_10bit`,`video_streaming_mode`,`use_cpu`,`cpu_encode_threading`,`use_paint_over_quality`,`enable_binary_clipboard`,`force_aligned_resolution`],a=[`video_crf`,`audio_bitrate`,`jpeg_quality`,`paint_over_jpeg_quality`,`video_paintover_crf`,`video_paintover_burst_frames`,`scaling_dpi`,`video_bitrate`];for(let n in localStorage)if(Object.hasOwnProperty.call(localStorage,n)&&n.startsWith(e)){let o=n.substring(e.length),s=`_${j}`,c=j!==`primary`&&o.endsWith(s),l=c?o.slice(0,-s.length):o;if(!c&&j!==`primary`&&it.includes(l))continue;if(r.includes(l)){if(nt.includes(l)&&!rt.has(l)&&localStorage.getItem(`${n}_explicit_choice`)!==`true`)continue;let e=localStorage.getItem(n);if(i.includes(l))e=e===`true`;else if(a.includes(l)&&(e=parseInt(e,10),isNaN(e)))continue;t[l]=e}}if(t.encoder!==void 0&&fa()&&(t.encoderFallback=!0),window.manual_resolution&&z!=null&&B!=null)t.manual_resolution=!0,t.manual_width=Q(z),t.manual_height=Q(B);else{let e=document.querySelector(`.video-container`),r=e?e.getBoundingClientRect():{width:window.innerWidth,height:window.innerHeight};t.manual_resolution=!1,t.initialClientWidth=Q(r.width*n),t.initialClientHeight=Q(r.height*n)}t.scaling_dpi===void 0&&(t.scaling_dpi=pn()),Kr=Xo(),Kr!==null&&(t.framerate=Kr),mi&&(t.keyboardLayout=mi),t.useCssScaling=H,t.displayId=j,t.tabId=C();let o=E(j);o!==null&&(t.ccStartKbps=o),t.displayScale=Yo(n),$t=n,j===`display2`&&(t.displayPosition=tt),t.audioRedundancy=!0;try{let e=`SETTINGS,${JSON.stringify(t)}`;u.send(e),hi=!0,Jr!==null&&ei(),console.log(`[websockets] Sent initial settings (resolutions are physical) to server:`,t)}catch(e){console.error(`[websockets] Error constructing or sending initial settings:`,e)}}er.armLegacyWindow(5e3),u.send(`cr`),console.log(`[websockets] Sent initial clipboard request (cr) to server (cache-only).`),$s();let e=Tt;k=e?new Set(e.toggled):new Set,qe=!1,Ye=!1,S=e&&e.toggled.has(`video`)?e.video:!0,w=e&&e.toggled.has(`audio`)?e.audio:j===`primary`,window.postMessage({type:`pipelineStatusUpdate`,video:S,audio:w},window.location.origin),pt===null&&(pt=setInterval(Ue,500),console.log(`[websockets] Started client metrics every 500ms.`)),W||(T=!1,mt===null&&(mt=setInterval(He,50),console.log(`[websockets] Started sending backpressure ACKs every 50ms.`)))},ot=Promise.resolve(),M=0,st=async e=>{let t=new Response(new Blob([e]).stream().pipeThrough(new DecompressionStream(`gzip`)));return new TextDecoder().decode(await t.arrayBuffer())},ct=!1,N=Promise.resolve(),lt=0,ut=async e=>{let t=await new Response(new Blob([e]).stream().pipeThrough(new CompressionStream(`gzip`))).arrayBuffer(),n=new Uint8Array(t.byteLength+1);return n[0]=5,n.set(new Uint8Array(t),1),n.buffer},dt=e=>{let t=e.send.bind(e);e.send=e=>{ct&&typeof e==`string`&&e.length>=512?(lt++,N=N.then(async()=>{try{t(await ut(e))}catch{t(e)}finally{lt--}})):typeof e==`string`&&lt>0?N=N.then(()=>t(e)):t(e)}},ft=a=>{if(a.data instanceof ArrayBuffer){let e=a.data,t=new DataView(e);if(e.byteLength<1)return;J.noteBytes(e.byteLength);let o=t.getUint8(0),c=J.open?a.at>0?a.at:performance.timeOrigin+performance.now():NaN;if((o===3||o===4)&&(window.videoChunksReceived++,Ve=performance.now(),F!==null&&Ps()),W&&(o===3||o===4)&&(jt=performance.now(),L=0,Mt=0),o===1){if(j!==`primary`||e.byteLength<2)return;if(w||W){if(s){h&&h.state!==`running`&&h.resume().catch(e=>console.error(`Error resuming audio context`,e));let t=(new Uint8Array(e,1,1)[0]&vi)!==0;if(t&&e.byteLength<=2){s.postMessage({type:`quiet`});return}let n=bi(e).filter(e=>e.byteLength);for(let e=0;e<n.length;e++){if(!W&&window.currentAudioBufferDuration>=80){window.currentAudioDropped++;break}s.postMessage({type:`decode`,data:{opusBuffer:n[e],timestamp:performance.now()*1e3,quiet:t&&e===n.length-1}},[n[e]])}}else console.warn(`AudioDecoderWorker not ready. Attempting to initialize audio pipeline.`),Te().then(()=>{if(s){let t=bi(e);for(let e of t)if(e.byteLength!==0){if(!W&&window.currentAudioBufferDuration>=80){window.currentAudioDropped++;break}s.postMessage({type:`decode`,data:{opusBuffer:e,timestamp:performance.now()*1e3}},[e])}}})}}else if(o===3){if(e.byteLength<6)return;jo===`jpeg`&&(jo=null);let n=t.getUint16(2,!1);bs.note(n),W||(Ie=n,O=performance.now());let r=t.getUint16(4,!1),i=e.slice(6);if(!W&&S&&V===`jpeg`||W&&V===`jpeg`){if(i.byteLength===0)return;he(r,i,n,c)}}else if(o===4){if(e.byteLength<12)return;let a=t.getUint8(1),o=t.getUint16(2,!1);bs.note(o),W||(Ie=o,O=performance.now(),V!==`h264enc-striped`&&Zi.add(Ie));let s=t.getUint16(4,!1),l=t.getUint16(6,!1),u=t.getUint16(8,!1),d=t.getUint16(10,!1),f=e.slice(12);if(W&&V!==`h264enc-striped`&&l>0&&u>0&&(z!==l||B!==u)&&(z=l,B=u,console.log(`Shared mode: stream is ${z}x${B} (physical).`),ts(z,B,!0)),W&&typeof VideoDecoder>`u`){At||(At=!0,console.error(`Shared viewing needs WebCodecs VideoDecoder, which this browser lacks.`),Y&&(Y.textContent=`This browser cannot decode the shared stream (no WebCodecs).`,Y.classList.remove(`hidden`)));return}let p=r(a);if(jo){if(n(a)!==i(jo))return;jo=null}if(Ia&&qt(V)&&(W||S)){if(f.byteLength===0)return;if(p){let e=bo(a,f,l,u);e!==Ba&&(Ba=e)}if(vo(p,f,l,u,Ba||bo(a,null,l,u),o,d,c))return}if(Jt(V)&&(W||S)){if(f.byteLength===0)return;let e=zt[s],t=p?`key`:`delta`,r=!e||!e.hasReceivedKeyframe;if(t===`delta`&&r){Uc();return}let i=e&&e.framed&&p&&!ae(re(new Uint8Array(f)),e.description);if(!e||e.decoder.state===`closed`||i||e.decoder.state===`configured`&&(e.width!==l||e.height!==u)){if(e&&e.decoder.state!==`closed`)try{e.decoder.close()}catch(e){console.warn(`Error closing old VNC stripe decoder:`,e)}let t=new VideoDecoder({output:Bs.bind(null,s),error:e=>ls(e,s)});s===0&&$r.configured(),qt(V)&&Qr.cap!==null&&!Ia&&e&&(e.width!==l||e.height!==u)&&(Qr.reset(),ti(null));let r=bo(a,f,l,u),i=pe()===`avcc`&&r.startsWith(`avc1`),o=i?re(new Uint8Array(f)):null,c=Pr({codec:r,codedWidth:l,codedHeight:u,optimizeForLatency:!0,colorSpace:te(r,jr),...o?{description:o}:{}});q.config=c,Bi(c),zt[s]={decoder:t,pendingChunks:[],width:l,height:u,framed:i,description:o,hasReceivedKeyframe:!1},e=zt[s],We||=performance.now(),Fr(c).then(e=>{if(e)return t.configure(e);{Uo(r,n(a));let e=Error(`config not supported: ${r}`);return e.quiet=!0,Promise.reject(e)}}).then(()=>{ds(s)}).catch(e=>{if(e.quiet||console.error(`Error configuring VNC stripe decoder Y=${s}:`,e),zt[s]&&zt[s].decoder===t){try{t.state!==`closed`&&t.close()}catch{}delete zt[s]}})}if(e){if(t===`delta`&&!e.hasReceivedKeyframe){Uc();return}let n=qt(V);if(t===`key`&&(e.hasReceivedKeyframe=!0),n){let n=e.decoder.decodeQueueSize,r=$r.decide(t===`key`,o,d,n);if(Qr.decided(n,r===`lost`||r===`overload`),r===`lost`){Vc(o);return}if(r===`no_key`||r===`overload`){e.hasReceivedKeyframe=!1,Uc();return}}else if(t===`delta`&&e.decoder.decodeQueueSize>8){e.hasReceivedKeyframe=!1,Uc();return}let r=V===`h264enc-striped`?o:xs(),i={type:t,timestamp:r,data:e.framed?ie(new Uint8Array(f)):f};if(e.decoder.state===`configured`){let t=new EncodedVideoChunk(i);J.open&&(qt(V)&&q.starts.set(r,performance.now()),q.arrivals.set(Math.trunc(r),c));try{e.decoder.decode(t)}catch(e){Gc(e,`stripe_decode_Y=${s}`)}}else if(e.decoder.state===`unconfigured`||e.decoder.state===`configuring`){if(e.width&&(e.width!==l||e.height!==u)){console.warn(`Dropping stale stripe chunk for Y=${s}: ${l}x${u} vs decoder ${e.width}x${e.height}.`);return}e.pendingChunks.push(i)}else console.warn(`VNC stripe decoder for Y=${s} in unexpected state: ${e.decoder.state}. Dropping chunk.`)}}}else console.warn(`Unknown binary data payload type received:`,o)}else if(typeof a.data==`string`){if(a.data.startsWith(`CC_RATE `)){je(j,parseFloat(a.data.substring(8)));return}if(a.data.startsWith(`CONNECTION `)){J.setConnection(a.data.substring(11)===`poor`);return}if(a.data.startsWith(`DISPLAY_OWNER `)){console.log(`[websockets] This page owns the display now.`),Jo(`display owner`);return}if(a.data.startsWith(`KILL `)){let e=a.data.substring(5);console.error(`Received KILL message from server: ${e}`),Sc(),u&&(u.onclose=()=>{},u.close()),Y&&(Y.textContent=`Connection Terminated: ${e}`,Y.classList.remove(`hidden`));return}if(a.data.startsWith(`AUTH_SUCCESS,`)){let e;try{let t=a.data.substring(13);e=JSON.parse(t)}catch(e){console.error(`Failed to parse AUTH_SUCCESS message:`,e);return}f=e.role,p=e.slot,console.log(`Authentication successful. Received Role: ${f}, Slot: ${p}`),window.postMessage({type:`clientRoleUpdate`,role:f},window.location.origin),window.webrtcInput&&typeof window.webrtcInput.updateControllerSlot==`function`&&window.webrtcInput.updateControllerSlot(p),f===`viewer`&&(console.log(`Token-based client is a 'viewer'. Applying shared mode compatibility settings.`),W=!0,window.webrtcInput&&window.webrtcInput.setSharedMode(!0),or=`shared`,sr=p!==null&&p>0?p-1:void 0,(!z||z<=0||!B||B<=0)&&(z=1280,B=720),ts(z,B,!0),window.addEventListener(`resize`,()=>{W&&z&&B&&z>0&&B>0&&ts(z,B,!0)}),os(),Ge&&(console.log(`Post-init sync: Forcing shared mode state because 'MODE websockets' was handled before auth.`),dr=`ready`,u&&u.readyState===WebSocket.OPEN&&(u.send(`STOP_VIDEO`),setTimeout(()=>{u&&u.readyState===WebSocket.OPEN&&(document.hidden?(fr=!0,console.log(`Shared mode: hidden on init, leaving video paused.`)):(u.send(`START_VIDEO`),console.log(`Shared mode: Sent START_VIDEO after initial STOP_VIDEO.`)))},250))))}if(a.data.startsWith(`MK_ACCESS,`)){let e=parseInt(a.data.split(`,`)[1])===1;console.log(`Received MK_ACCESS update: ${e}`),window.webrtcInput&&(e?window.webrtcInput.isInputAttached()||(console.log(`MK Access Granted: Attaching input context.`),window.webrtcInput.attach_context()):(console.log(`MK Access Revoked: Detaching input context.`),window.webrtcInput.detach_context()))}if(a.data.startsWith(`ROLE_UPDATE,`)){let e;try{let t=a.data.substring(12);e=JSON.parse(t)}catch(e){console.error(`Failed to parse ROLE_UPDATE message:`,e);return}console.log(`Received role update. New role: ${e.role}, New slot: ${e.slot}`);let t=p;f=e.role,p=e.slot,window.webrtcInput&&typeof window.webrtcInput.updateControllerSlot==`function`&&window.webrtcInput.updateControllerSlot(p),t!==null&&p===null?window.webrtcInput&&window.webrtcInput.gamepadManager&&(console.log(`Controller slot revoked, disabling gamepad polling.`),window.webrtcInput.gamepadManager.disable()):t===null&&p!==null&&(window.webrtcInput&&window.webrtcInput.gamepadManager&&Fe?(console.log(`Controller slot granted and global gamepad toggle is ON. Enabling gamepad polling.`),window.webrtcInput.gamepadManager.enable()):window.webrtcInput&&window.webrtcInput.gamepadManager&&console.log(`Controller slot granted, but global gamepad toggle is OFF. Polling remains disabled.`))}if(a.data===`MODE websockets`){if(Ct=!0,d=`websockets`,console.log(`[websockets] Switched to websockets mode.`),Oi=`initializing`,ki=`Initializing WebSocket mode...`,wa(),!m){let e=fn();e===`#shared`?(f=`viewer`,p=null):e.startsWith(`#player`)?(f=`viewer`,p=parseInt(e.substring(7),10)||null,p!==null&&(sr=p-1)):(f=`controller`,p=1,sr=0),console.log(`Legacy mode detected. Role from hash: ${f}, Slot: ${p}`),rc()}cs(),Tc(),Ec(),W||(Fc(),Rc(),m||rc()),Te().then(e=>{e||De()}),m&&rc(),window.webrtcInput&&typeof window.webrtcInput.setTrackpadMode==`function`&&(window.webrtcInput.setTrackpadMode(an),window.webrtcInput.resumePointerEcho()),ea&&ea.classList.add(`hidden`),Y&&!St&&Y.classList.remove(`hidden`),_e(),W?(dr=`ready`,console.log(`Shared mode: Received 'MODE websockets'. Requesting initial stream with STOP/START_VIDEO. State: ready.`),zs(),u&&u.readyState===WebSocket.OPEN&&(u.send(`STOP_VIDEO`),setTimeout(()=>{u&&u.readyState===WebSocket.OPEN&&(document.hidden?(fr=!0,console.log(`Shared mode: hidden on init, leaving video paused.`)):(u.send(`START_VIDEO`),console.log(`Shared mode: Sent START_VIDEO after initial STOP_VIDEO.`)))},250))):u&&u.readyState===WebSocket.OPEN&&w&&(qe?u.send(`START_AUDIO`):Ye=!0),ki=`Waiting for stream...`,wa(),Ge=!0,J.subscribe(),qi!==null&&clearInterval(qi);let e=0;qi=setInterval(()=>{if(Ki||!S||Mo||!u||u.readyState!==WebSocket.OPEN||e>=5){clearInterval(qi),qi=null;return}e++,console.log(`No frame since connect; requesting keyframe (attempt ${e}).`),Uc()},3e3)}else if(d===`websockets`){if(a.data.startsWith(`{`)){let e;try{e=JSON.parse(a.data)}catch(e){console.error(`Error parsing JSON:`,e);return}if(e.type===`stream_info`)J.setInfo(e.info),Mr(e.info);else if(e.type===`stream_stats`)J.serverSample(e.stats);else if(e.type===`display_settings`)hc(e.settings||{});else if(e.type===`server_settings`){if(Je=e.settings,j!==`primary`&&e.settings.second_screen&&e.settings.second_screen.value===!1){console.error(`The server reports no second display is available. This client will not function.`),Y&&(Y.textContent=`Error: A second display is not available on this server.`,Y.classList.remove(`hidden`)),u&&(u.onclose=()=>{},u.close()),Sc();return}let t=ya(e.settings);if(typeof window.encoder==`string`&&window.encoder!==V){let e=window.encoder;console.log(`Server settings switch encoder ${V} -> ${e}.`),V=e,oo(),e!==`h264enc-striped`&&cs(),Tc(),Ec()}Number.isFinite(parseFloat(window.framerate))&&(Br=parseFloat(window.framerate));let n=e.settings.framerate;Vr=n&&n.min!==void 0?{min:n.min,max:n.max}:null,Zo(`server framerate span`),typeof window.video_fullcolor==`boolean`&&(ri=window.video_fullcolor);let r=e.settings&&e.settings.video_fullcolor;wo=!!(r&&r.locked),ri&&To(`full color the server announced is not decoded here`),typeof window.video_10bit==`boolean`&&(ii=window.video_10bit);let i=e.settings&&e.settings.video_10bit;Do=!!(i&&i.locked),ii&&ko(`10-bit the server announced is not decoded here`),typeof window.video_streaming_mode==`boolean`&&(ui=window.video_streaming_mode);let a=e.settings&&e.settings.command_enabled;pr=a&&typeof a.value==`boolean`?a.value:!0,qe||(qe=!0,cc(e.settings),tc(),document.hidden&&!W&&(console.log(`Tab is hidden on connect, pausing video until it is shown.`),x())),Ye&&(Ye=!1,w&&u&&u.readyState===WebSocket.OPEN&&u.send(`START_AUDIO`));let o=e.settings&&e.settings.enable_resize;o&&typeof o.value==`boolean`&&(window.enable_resize=o.value);let s=e.settings&&e.settings.clipboard_in_enabled;s&&typeof s.value==`boolean`&&(xn=s.value);let c=e.settings&&e.settings.clipboard_out_enabled;c&&typeof c.value==`boolean`&&(Cn=c.value);let l=e.settings&&e.settings.enable_binary_clipboard;l&&typeof l.value==`boolean`&&(Kn=l.locked?l.value:Z(`enable_binary_clipboard`,l.value));let d=e.settings&&e.settings.webcam_encoder;if(d&&rr.includes(d.value)){let e=sa(`webcam_encoder`,d.value);et=d.locked||!rr.includes(e)?d.value:e}let f=ga(e.settings);f!==H&&window.postMessage({type:`setUseCssScaling`,value:f},window.location.origin);let p=_a(e.settings);p!==On&&(On=p,An());let m=va(e.settings);m!==Fn&&(Fn=m,Ln()),ee(),Le(e.settings),window.postMessage({type:`serverSettings`,payload:e.settings},window.location.origin),Object.keys(t).length>0&&(console.log(`Client settings were sanitized by server rules. Sending updates back to server:`,t),mc(t,!0)),e.settings.encoder_backends&&(Io=e.settings.encoder_backends.value||null),typeof window.encoder==`string`&&Ko(window.encoder,e.settings.encoder);let h=e.settings&&e.settings.manual_resolution&&e.settings.manual_resolution.value===!0;if(h||window.manual_resolution){if(console.log(`Manual resolution mode active (Server forced: ${h}, Client pref: ${window.manual_resolution}). Switching to manual resize handlers.`),h){let t=e.settings.manual_width?parseInt(e.settings.manual_width.value,10):0,n=e.settings.manual_height?parseInt(e.settings.manual_height.value,10):0;t>0&&n>0?(console.log(`Applying server-enforced manual resolution: ${t}x${n}`),window.manual_resolution=!0,z=t,B=n,ts(z,B,Yi),mn(`server resolution`)&&Jo(`server resolution`)):console.warn(`Server dictated manual mode but did not provide valid dimensions.`)}else z&&B&&ts(z,B,Yi);as()}else console.log(`Server settings payload confirms auto mode. Switching to auto resize handlers.`),rs()}else if(e.type===`server_apps`)e.apps&&Array.isArray(e.apps)&&window.postMessage({type:`systemApps`,apps:e.apps},window.location.origin);else if(e.type===`print_document`)fn().startsWith(`#display2`)||ba.announce(e.name,e.size_bytes);else if(e.type===`pipeline_status`){let t=!1;e.video!==void 0&&e.video!==S&&(S=e.video,t=!0,!S&&Jt(V)&&!W&&cs()),e.audio!==void 0&&e.audio!==w&&(w=e.audio,t=!0,s&&s.postMessage({type:`updatePipelineStatus`,data:{isActive:w}}),u&&u.setAudioActive&&u.setAudioActive(w)),t&&window.postMessage({type:`pipelineStatusUpdate`,video:S,audio:w},window.location.origin)}else if(e.type===`stream_resolution`){let t=e.displayId||`primary`;if(t!==j)console.log(`Ignoring stream_resolution for display '${t}' (this page renders '${j}').`);else if(W){if(dr===`error`||dr===`idle`)console.log(`Shared mode: Received stream_resolution while in state '${dr}'. Ignoring.`);else{let t=parseInt(e.width,10),n=parseInt(e.height,10);if(t>0&&n>0){let e=Q(t),r=Q(n),i=z!==e||B!==r;i&&(console.log(`Shared mode: Received new stream resolution ${e}x${r} (physical).`),z=e,B=r,ts(z,B,!0)),dr===`ready`&&i&&(console.log(`Shared mode: Clearing decoders and canvas for new resolution.`),cs(),l&&c.width>0&&c.height>0&&(l.setTransform(1,0,0,1,0,0),l.clearRect(0,0,c.width,c.height)))}else console.warn(`Shared mode: Received invalid stream_resolution dimensions: ${e.width}x${e.height}`)}}else{let t=parseInt(e.width,10),n=parseInt(e.height,10);if(t>0&&n>0){let e=window.manual_resolution?1:Zt(),r=Q(t),i=Q(n),a=!window.manual_resolution&&en&&r===en[0]&&i===en[1];c&&r>0&&i>0&&(c.width!==r||c.height!==i)&&(cs(),a?(window.streamResolutionDiverged=!1,ns(en[2],en[3])):(console.log(`Server realized stream resolution ${t}x${n} (canvas buffer ${c.width}x${c.height}); reconciling.`),window.streamResolutionDiverged=!0,window.manual_resolution?(z=r,B=i,ts(z,B,Yi)):ts((r+.5)/e,(i+.5)/e,!0)))}else console.warn(`Received invalid stream_resolution dimensions: ${e.width}x${e.height}`)}}else console.warn(`Unexpected JSON message type:`,e.type,e)}else if(a.data.startsWith(`cursor,`))try{let e=JSON.parse(a.data.substring(7));window.webrtcInput&&typeof window.webrtcInput.updateServerCursor==`function`&&window.webrtcInput.updateServerCursor(e)}catch(e){console.error(`Error parsing cursor data:`,e)}else if(a.data.startsWith(`clipboard_reply,`))a.data.substring(16)===`cr`&&tr();else if(a.data===`clipboard_secret`)Qn.markSecret();else if(a.data.startsWith(`clipboard_start,`)){let e=a.data.split(`,`);Qn.begin(e[1],parseInt(e[2],10),nr())}else if(a.data.startsWith(`clipboard_data,`))Qn.push(a.data.substring(15));else if(a.data===`clipboard_finish`)Qn.finish();else if(a.data.startsWith(`clipboard_binary,`)){let e=a.data.split(`,`);if(e.length<3){console.error(`Malformed binary clipboard message from server:`,a.data);return}Qn.single(e[1],e[2],nr())}else if(a.data.startsWith(`clipboard,`))Qn.single(`text/plain`,a.data.substring(10),nr());else if(a.data.startsWith(`system,`))try{let e=JSON.parse(a.data.substring(7));if(e.action===`reload`)window.location.reload();else if(typeof e.action==`string`&&e.action.startsWith(`command_error,`)&&!W)window.postMessage({type:`fileUpload`,payload:{status:`warning`,fileName:`command`,message:e.action.slice(14),code:`commandFailed`}},window.location.origin);else if(typeof e.action==`string`&&e.action.startsWith(`command_done,`)&&!W)window.postMessage({type:`commandDone`,command:e.action.slice(13)},window.location.origin);else if(typeof e.action==`string`&&e.action.startsWith(`apps_installed,`)&&!W)window.postMessage({type:`appsInstalled`,apps:JSON.parse(e.action.slice(15))},window.location.origin);else if(typeof e.action==`string`&&e.action.startsWith(`rumble,`)&&window.webrtcInput){let[t,n,r,i]=e.action.split(`,`).slice(1).map(Number);window.webrtcInput.rumble(t,n,r,i)}else typeof e.action==`string`&&e.action.startsWith(`pointer,`)&&window.webrtcInput&&window.webrtcInput.onPointerEcho(e.action)}catch(e){console.error(`Error parsing system data:`,e)}else if(a.data===`VIDEO_STARTED`&&!W)Ps(),S=!0,window.postMessage({type:`pipelineStatusUpdate`,video:!0},window.location.origin);else if(a.data===`VIDEO_STOPPED`&&!W)console.log(`Client: Received VIDEO_STOPPED. Updating isVideoPipelineActive=false. Expecting PIPELINE_RESETTING from server for full state reset.`),S=!1,window.postMessage({type:`pipelineStatusUpdate`,video:!1},window.location.origin);else if(a.data.startsWith(`PIPELINE_RESETTING `)){let e=a.data.split(` `),t=e.length>1?e[1]:`primary`;console.log(`[websockets] Received PIPELINE_RESETTING for display '${t}'.`),W&&t===`primary`||!W&&t===j?(Bc(`PIPELINE_RESETTING from server for display '${t}'`),W?(console.log(`Shared mode: Primary pipeline reset. Client remains in ready state.`),dr=`ready`):console.log(`Display '${j}': Video reset complete.`)):console.log(`Ignoring PIPELINE_RESETTING for '${t}' as this client is '${W?`shared`:j}'.`)}else if(a.data.startsWith(`DISPLAY_CONFIG_UPDATE,`))try{let n=a.data.substring(a.data.indexOf(`,`)+1),r=JSON.parse(n);if(t=r.layouts||null,U=!!r.wayland,Yt=!!r.finger_scroll,window.webrtcInput&&window.webrtcInput.setFingerScroll&&window.webrtcInput.setFingerScroll(Yt),window.webrtcInput&&window.webrtcInput.setDisplayLayouts&&window.webrtcInput.setDisplayLayouts(t,j),rn(),j===`primary`){let t=r.displays.includes(`display2`);e!==t&&(console.log(`Secondary display connection status changed to: ${t}`),e=t,Dn())}}catch(e){console.error(`Error parsing DISPLAY_CONFIG_UPDATE:`,e,`Original data:`,a.data)}else if(a.data===`AUDIO_STARTED`&&!W)w=!0,window.postMessage({type:`pipelineStatusUpdate`,audio:!0},window.location.origin),s&&s.postMessage({type:`updatePipelineStatus`,data:{isActive:!0}}),u&&u.setAudioActive&&u.setAudioActive(!0);else if(a.data===`AUDIO_STOPPED`&&!W)w=!1,window.postMessage({type:`pipelineStatusUpdate`,audio:!1},window.location.origin),s&&s.postMessage({type:`updatePipelineStatus`,data:{isActive:!1}}),u&&u.setAudioActive&&u.setAudioActive(!1);else if(a.data===`AUDIO_DISABLED`&&!W){if(console.log(`Server reports audio is disabled. Tearing down audio workers.`),Ke=!1,w=!1,s&&(s.postMessage({type:`updatePipelineStatus`,data:{isActive:!1}}),u&&u.setAudioActive&&u.setAudioActive(!1),s.postMessage({type:`close`}),setTimeout(()=>{s&&=(s.terminate(),null)},50)),h){try{h.close()}catch(e){console.error(`Error closing AudioContext on AUDIO_DISABLED:`,e)}h=null,ac(),g=null,v=null}window.postMessage({type:`pipelineStatusUpdate`,audio:!1},window.location.origin)}else if(a.data===`MICROPHONE_DISABLED`&&!W)console.log(`Server reports microphone is disabled. Stopping microphone capture.`),Xe=!1,Fc(),window.postMessage({type:`pipelineStatusUpdate`,microphone:!1},window.location.origin);else if(a.data===`WEBCAM_DISABLED`&&!W)console.log(`Server reports webcam is disabled. Stopping webcam capture.`),Ze=!1,Rc(),window.postMessage({type:`pipelineStatusUpdate`,webcam:!1},window.location.origin);else if(a.data===`WEBCAM_KEYFRAME`)A&&A.requestKeyframe();else if(a.data.startsWith(`CAPTURE_DEMAND `)&&!W){let[e,t]=a.data.slice(15).split(` `);e===`webcam`&&Ze&&!k.has(`webcam`)?t===`1`?$e||Lc(!0):Rc():e===`microphone`&&Xe&&!k.has(`microphone`)&&(t===`1`?Qe||Pc(!0):Fc())}else window.webrtcInput&&window.webrtcInput.on_message&&!W&&window.webrtcInput.on_message(a.data)}}},ht=e=>{let t=e.data;if(t instanceof ArrayBuffer){if(t.byteLength>=1&&new Uint8Array(t,0,1)[0]===5){M++;let e=t.slice(1);ot=ot.then(async()=>{try{ft({data:await st(e)})}catch(e){console.error(`[websockets] gzip control inflate failed:`,e)}finally{M--}});return}ft(e);return}if(t===`_gz,1`){typeof CompressionStream<`u`&&(ct=!0);return}M>0?ot=ot.then(()=>ft({data:t})):ft({data:t})},bt=e=>{console.error(`[websockets] Error:`,e),Oi=`error`,ki=`WebSocket connection error.`,wa(),pt&&=(clearInterval(pt),null),mt&&=(clearInterval(mt),null),Ys(),W&&(console.error(`Shared mode: WebSocket error. Resetting shared state to 'error'.`),dr=`error`)},P=e=>{if(console.log(`[websockets] Connection closed`,e),J.disconnected(),window.webrtcInput&&typeof window.webrtcInput.stopRumble==`function`&&window.webrtcInput.stopRumble(),Qn.reset(),window.__selkiesAuthProbe&&window.__selkiesAuthProbe(),e.code===4001){console.error(`Server rejected connection: Invalid token. Disabling reconnect.`),Sc(),ki=`Connection Failed: Invalid Token`,wa();return}e.code===4002&&(console.log(`Server closed connection due to permission change. Reconnecting...`),gt=!0);let t=/superseded/i.test(e.reason||``);t&&(console.warn(`Session superseded by a new connection. Auto-reconnect disabled.`),Sc()),Oi=`disconnected`,Ct=!1,ki=t?`Session opened elsewhere. Reload this page to take over.`:`WebSocket disconnected. Attempting to reconnect...`,wa(),pt&&=(clearInterval(pt),null),mt&&=(clearInterval(mt),null);let n=!t&&!gt;n&&yt&&!St&&(St=!0,Et=performance.now(),Tt={toggled:new Set(k),video:S,audio:w,microphone:T,webcam:Ne}),Tc(),cs(),Ds(),W||(Fc(),Rc()),S=!1,w=!1,T=!1;let r=()=>{Ys(),s&&=(s.postMessage({type:`close`}),null),window.postMessage({type:`pipelineStatusUpdate`,video:!1,audio:!1},window.location.origin)};St&&n?(v&&v.postMessage({quiet:!0}),wt===null&&(wt=setTimeout(()=>{wt=null,!Ki&&(ec(),r(),Y&&Y.classList.remove(`hidden`))},1500))):(ec(),r()),W&&(console.log(`Shared mode: WebSocket closed. Resetting shared state to 'idle'.`),dr=`idle`,Rs()),Ie=-1,vs=null,Re=-1,Ec(),ct=!1,t||(Ki=!1,Y&&!St&&Y.classList.remove(`hidden`),yt&&performance.now()-yt>=1e4&&(_t=0),bc(e.code===1006&&_t===0)),yt=0},Dt=()=>{dt(u),u.onopen=at,u.onmessage=ht,u.onerror=bt,u.onclose=P};Dt(),xt=()=>{Pe(),Dt()}}let yc=!1;function bc(e=!1){if(ht!==null||!xt)return;let t=Math.min(400*2**_t,1e3);if(_t++,e&&!window.__selkiesModeSwitching&&!gt){xc(!0);return}let n=setTimeout(async()=>{if(window.__selkiesModeSwitching){ht=null;return}let e=new URL(window.location.href);e.pathname=Ee()+`/api/websockets`;let t=await De(e.href,_n());if(ht===n){if(ht=null,!t){bc();return}if(t.status===409||gt||vt>=3){wc(t);return}xc()}},t);ht=n}function xc(e=!1){e||vt++,console.log(`[websockets] Reconnecting in place (attempt ${_t}).`),xt();let t=u;setTimeout(()=>{u===t&&t.readyState===WebSocket.CONNECTING&&t.close()},5e3)}window.addEventListener(`online`,()=>{ht!==null&&(Sc(),_t=0,bc())});function Sc(){ht!==null&&clearTimeout(ht),ht=null}async function Cc(){let e=await Oe(_n());return e===null?!1:bt===null?(bt=e,!1):e!==bt}function wc(e){let t=null;try{t=sessionStorage.getItem(`selkies_mode_flip`)}catch{}if(!yc&&!t&&e.status===409){try{sessionStorage.setItem(`selkies_mode_flip`,`1`)}catch{}_r(`${G}_stream_mode`,`webrtc`),console.warn(`[websockets] Server is serving WebRTC (endpoint 409); switching stored mode.`)}location.reload()}document.readyState===`loading`?document.addEventListener(`DOMContentLoaded`,vc):vc();function Tc(){let e=0;for(;Se.length>0;){let t=Se.shift();if(t&&t.image&&typeof t.image.close==`function`)try{t.image.close(),e++}catch{}}e>0&&console.log(`Cleanup: Closed ${e} JPEG stripe images.`),Ns={},gs=null,_s=!1}function Ec(){for(;fs.length>0;){let e=fs.shift();try{e&&e.frame&&e.frame.close()}catch{}}gs=null,_s=!1}let Dc={6:{streams:4,coupled:2,mapping:[0,4,1,2,3,5]},8:{streams:5,coupled:3,mapping:[0,6,1,2,3,4,5,7]}};function Oc(){let e=parseInt(window.audio_channels,10);return e===1||e===2||e===6||e===8?e:2}function kc(){return new URL(`codecs/libopus-wasm/index.js`,document.baseURI).href}function Ac(e){let t=Dc[e];if(!t)return null;let n=new ArrayBuffer(21+e),r=new Uint8Array(n),i=new DataView(n);return r.set([79,112,117,115,72,101,97,100]),r[8]=1,r[9]=e,i.setUint16(10,0,!0),i.setUint32(12,48e3,!0),i.setInt16(16,0,!0),r[18]=1,r[19]=t.streams,r[20]=t.coupled,r.set(t.mapping,21),n}let jc=`
  let decoderAudio;
  let pipelineActive = true;
  let currentDecodeQueueSize = 0;
  // libopus-wasm, where the engine has no AudioDecoder, and whether no decoder
  // can be had, which leaves packets undecoded until the page asks again.
  let opusUrl = null;
  let opusModule = null;
  let decoderUnavailable = false;
  // Set once the page hands over the worklet's line; until then decoded packets
  // go back through the page, which is also the path a worklet-less build takes.
  let pcmPort = null;
  let audioIn = null;
  let lastAudioTs = null;

  // Outputs still due before a pending mark goes out; 0 when none is pending.
  let quietAfter = 0;
  // Per decode in flight, in order: whether that frame ends a sound, so its PCM
  // goes to the worklet marked quiet.
  const endsSound = [];

  // Tells the worklet the server's silence gate closed, behind the PCM of every
  // packet before the mark and ahead of any after it: a mark that overtakes a
  // decode waits for the outputs due when it came, and no more.
  function forwardQuiet() {
    if (currentDecodeQueueSize > 0) { quietAfter = currentDecodeQueueSize; return; }
    postQuiet();
  }

  function postQuiet() {
    quietAfter = 0;
    if (pcmPort) pcmPort.postMessage({ quiet: true });
    else self.postMessage({ type: 'audioQuiet' });
  }

  // One decode's output has gone to the worklet (or been dropped).
  function outputDone() {
    if (quietAfter > 0 && --quietAfter === 0) postQuiet();
  }

  function audioTsNewer(a, b) {
    const d = (a - b) >>> 0;
    return d !== 0 && d < 0x80000000;
  }

  function extractOpusFrames(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    if (arrayBuffer.byteLength <= 2) return [];
    const nRed = bytes[1] & ~${vi};
    if (!nRed) { lastAudioTs = null; return [arrayBuffer.slice(2)]; }
    // With n_red > 0 the bytes after the flag word are headers, not Opus, so a
    // truncated fixed part leaves no primary to salvage.
    if (arrayBuffer.byteLength < 6 + nRed * 4 + 1) { lastAudioTs = null; return []; }
    const pts = ((bytes[2] << 24) | (bytes[3] << 16) | (bytes[4] << 8) | bytes[5]) >>> 0;
    let pos = 6;
    const offsets = [], lens = [];
    for (let i = 0; i < nRed; i++) {
      const field = (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
      offsets.push((field >> 10) & 0x3fff);
      lens.push(field & 0x3ff);
      pos += 4;
    }
    pos += 1;
    // The declared block lengths must fit the payload: slice() clamps silently,
    // and the primary cannot be located without trustworthy lengths.
    let declared = pos;
    for (let i = 0; i < nRed; i++) { declared += lens[i]; }
    if (declared > arrayBuffer.byteLength) { lastAudioTs = null; return []; }
    const blocks = [];
    for (let i = 0; i < nRed; i++) {
      blocks.push({ ts: (pts - offsets[i]) >>> 0, buf: arrayBuffer.slice(pos, pos + lens[i]) });
      pos += lens[i];
    }
    blocks.push({ ts: pts, buf: arrayBuffer.slice(pos) });
    if (lastAudioTs === null) {
      lastAudioTs = pts;
      return [blocks[blocks.length - 1].buf];
    }
    const out = [];
    let last = lastAudioTs;
    for (const b of blocks) {
      if (audioTsNewer(b.ts, last)) { out.push(b.buf); last = b.ts; }
    }
    lastAudioTs = last;
    return out;
  }
  const decoderConfig = {
    codec: 'opus',
    numberOfChannels: 2,
    sampleRate: 48000,
  };

  // An Opus frame length field at pos (RFC 6716 3.2.1): [bytes it takes, length].
  function frameLength(u8, pos) {
    const b = u8[pos];
    return b < 252 ? [1, b] : [2, b + 4 * u8[pos + 1]];
  }

  // The elementary packets of a multistream packet. Every stream but the last
  // is self-delimited (RFC 6716 Appendix B): a plain packet with one more
  // length field in front of its last frame's data, which is cut out here.
  function splitStreams(buf, streams) {
    const u8 = new Uint8Array(buf);
    const out = [];
    let pos = 0;
    for (let s = 0; s < streams - 1; s++) {
      if (pos >= u8.length) return null;
      const start = pos;
      const code = u8[pos++] & 3;
      let pad = 0, data = 0, sdAt, sdSize, n, len;
      if (code === 2) {
        [n, len] = frameLength(u8, pos); pos += n; data = len;
      } else if (code === 3) {
        const count = u8[pos++];
        if (count & 0x40) {
          let p;
          do { p = u8[pos++]; pad += p === 255 ? 254 : p; } while (p === 255);
        }
        if (count & 0x80) {
          for (let i = 0; i < (count & 0x3f) - 1; i++) { [n, len] = frameLength(u8, pos); pos += n; data += len; }
        }
      }
      sdAt = pos;
      [sdSize, len] = frameLength(u8, pos);
      pos += sdSize;
      data = code === 1 ? 2 * len : code === 3 && !(u8[start + 1] & 0x80) ? (u8[start + 1] & 0x3f) * len : data + len;
      const end = pos + data + pad;
      if (end > u8.length) return null;
      const plain = new Uint8Array(end - start - sdSize);
      plain.set(u8.subarray(start, sdAt), 0);
      plain.set(u8.subarray(sdAt + sdSize, end), sdAt - start);
      out.push(plain.buffer);
      pos = end;
    }
    out.push(buf.slice(pos));
    return out;
  }

  // A decoder for the surround layout of an OpusHead description: one mono or
  // stereo decoder per elementary stream, whose outputs are reassembled into
  // interleaved frames of the channels the mapping table names, in order.
  function surroundDecoder(description, channels, onPcm, onError) {
    const head = new Uint8Array(description);
    const streams = head[19], coupled = head[20];
    const mapping = Array.from(head.subarray(21, 21 + channels));
    const decoders = [], held = [];
    const assemble = () => {
      while (held.every((q) => q.length > 0)) {
        const parts = held.map((q) => q.shift());
        const frames = parts[0].frames;
        const pcm = new Float32Array(frames * channels);
        mapping.forEach((coded, c) => {
          if (coded === 255) return;
          const stream = coded < 2 * coupled ? coded >> 1 : coupled + coded - 2 * coupled;
          const plane = parts[stream].planes[coded < 2 * coupled ? coded & 1 : 0];
          for (let f = 0; f < frames && f < plane.length; f++) pcm[f * channels + c] = plane[f];
        });
        onPcm(pcm.buffer);
      }
    };
    for (let k = 0; k < streams; k++) {
      held.push([]);
      decoders.push(new AudioDecoder({
        output: (d) => {
          const planes = [];
          for (let c = 0; c < d.numberOfChannels; c++) {
            const plane = new Float32Array(d.numberOfFrames);
            d.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
            planes.push(plane);
          }
          held[k].push({ frames: d.numberOfFrames, planes });
          d.close();
          assemble();
        },
        error: onError,
      }));
    }
    return {
      get state() {
        return decoders.some((d) => d.state === 'closed') ? 'closed'
          : decoders.every((d) => d.state === 'configured') ? 'configured' : 'unconfigured';
      },
      async configure() {
        for (let k = 0; k < streams; k++) {
          decoders[k].configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: k < coupled ? 2 : 1 });
        }
      },
      decode(chunk) {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        const parts = splitStreams(bytes.buffer, streams);
        if (!parts) throw new Error('malformed multistream packet');
        parts.forEach((part, k) => decoders[k].decode(
          new EncodedAudioChunk({ type: 'key', timestamp: chunk.timestamp, data: part })));
      },
      close() {
        for (const d of decoders) { try { d.close(); } catch (e) { /* closed */ } }
      },
    };
  }

  // libopus in WASM for an engine with no AudioDecoder: mono and stereo decode
  // as they are, surround one elementary stream at a time into the order of
  // the description's mapping table, as surroundDecoder does. A packet's PCM
  // goes out a microtask after its decode call, as a WebCodecs output would,
  // so the caller's queue accounting has run first.
  function wasmDecoder(config, onPcm, onError) {
    const channels = config.numberOfChannels;
    const head = channels > 2 && config.description ? new Uint8Array(config.description) : null;
    const streams = head ? head[19] : 1, coupled = head ? head[20] : 0;
    const mapping = head ? Array.from(head.subarray(21, 21 + channels)) : null;
    const decoders = [];
    const dec = {
      state: 'configuring',
      decode(buffer) {
        const parts = head ? splitStreams(buffer, streams) : [buffer];
        if (!parts) throw new Error('malformed multistream packet');
        queueMicrotask(() => {
          if (dec.state !== 'configured') return;
          let outs;
          try { outs = parts.map((part, k) => decoders[k].decodeFloat(new Uint8Array(part))); }
          catch (e) { onError(e); return; }
          if (!head) { onPcm(outs[0].buffer); return; }
          const frames = outs[0].length / (coupled ? 2 : 1);
          const pcm = new Float32Array(frames * channels);
          mapping.forEach((coded, c) => {
            if (coded === 255) return;
            const paired = coded < 2 * coupled;
            const out = outs[paired ? coded >> 1 : coded - coupled];
            for (let f = 0; f < frames; f++) pcm[f * channels + c] = paired ? out[2 * f + (coded & 1)] : out[f];
          });
          onPcm(pcm.buffer);
        });
      },
      close() {
        dec.state = 'closed';
        for (const d of decoders) { try { d.free(); } catch (e) { /* freed */ } }
      },
    };
    dec.ready = (async () => {
      if (!opusUrl) throw new Error('no AudioDecoder and no WASM decoder to fall back on');
      opusModule = opusModule || import(opusUrl);
      const opus = await opusModule;
      for (let k = 0; k < streams; k++) {
        decoders.push(await opus.createDecoder({ sampleRate: 48000, channels: head ? (k < coupled ? 2 : 1) : channels }));
      }
      if (dec.state === 'closed') dec.close();
      else dec.state = 'configured';
    })();
    return dec;
  }

  // A packet as the decoder takes it: a chunk for WebCodecs, the bytes for WASM.
  function packet(buffer, timestamp) {
    return typeof AudioDecoder === 'undefined' ? buffer : new EncodedAudioChunk({ type: 'key', timestamp, data: buffer });
  }

  function postPcm(pcm, ending) {
    if (pcmPort) pcmPort.postMessage(ending ? { audioData: pcm, quiet: true } : { audioData: pcm }, [pcm]);
    else self.postMessage({ type: 'decodedAudioData', pcmBuffer: pcm, quiet: ending }, [pcm]);
  }

  async function initializeDecoderInWorker() {
    if (decoderAudio && decoderAudio.state !== 'closed') {
      try { decoderAudio.close(); } catch (e) { /* ignore */ }
    }
    currentDecodeQueueSize = 0;
    endsSound.length = 0;
    quietAfter = 0;
    decoderUnavailable = false;
    const onError = (e) => {
      // A fatal decoder error is not re-initialized from here: a persistent
      // failure would spin. The page drives recovery with its 'reinitialize'
      // message, which also re-checks the codec configuration.
      console.error('[AudioWorker] AudioDecoder error:', e.message, e);
      currentDecodeQueueSize = Math.max(0, currentDecodeQueueSize -1);
      endsSound.shift();
      outputDone();
    };
    const onPcm = (pcm) => {
      currentDecodeQueueSize = Math.max(0, currentDecodeQueueSize - 1);
      postPcm(pcm, !!endsSound.shift());
      outputDone();
    };
    const failed = (reason) => {
      decoderAudio = null;
      decoderUnavailable = true;
      self.postMessage({ type: 'decoderInitFailed', reason });
    };
    if (typeof AudioDecoder === 'undefined') {
      const wasm = wasmDecoder(decoderConfig, onPcm, onError);
      decoderAudio = wasm;
      try {
        await wasm.ready;
        if (decoderAudio === wasm) self.postMessage({ type: 'decoderInitialized', wasm: true });
      } catch (e) {
        if (decoderAudio === wasm) failed(String((e && e.message) || e));
      }
      return;
    }
    const surround = decoderConfig.numberOfChannels > 2 && decoderConfig.description;
    decoderAudio = surround
      ? surroundDecoder(decoderConfig.description, decoderConfig.numberOfChannels, onPcm, onError)
      : new AudioDecoder({ output: handleDecodedAudioFrameInWorker, error: onError });
    try {
      const support = await AudioDecoder.isConfigSupported(
        surround ? { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 } : decoderConfig);
      if (support.supported) {
        await decoderAudio.configure(decoderConfig);
        self.postMessage({ type: 'decoderInitialized' });
      } else {
        failed('configNotSupported');
      }
    } catch (e) {
      failed(e.message);
    }
  }

  async function handleDecodedAudioFrameInWorker(frame) {
    currentDecodeQueueSize = Math.max(0, currentDecodeQueueSize - 1);
    const ending = !!endsSound.shift();
    if (!frame || typeof frame.copyTo !== 'function' || typeof frame.allocationSize !== 'function' || typeof frame.close !== 'function') {
        if(frame && typeof frame.close === 'function') { try { frame.close(); } catch(e) { /* ignore */ } }
        outputDone();
        return;
    }
    let pcmDataArrayBuffer;
    try {
      const requiredByteLength = frame.allocationSize({ planeIndex: 0, format: 'f32' });
      if (requiredByteLength === 0) {
          try { frame.close(); } catch(e) { /* ignore */ }
          return;
      }
      pcmDataArrayBuffer = new ArrayBuffer(requiredByteLength);
      const pcmDataView = new Float32Array(pcmDataArrayBuffer);
      await frame.copyTo(pcmDataView, { planeIndex: 0, format: 'f32' });
      postPcm(pcmDataArrayBuffer, ending);
      pcmDataArrayBuffer = null;
    } catch (error) { /* console.error */ }
    finally {
      if (frame && typeof frame.close === 'function') {
        try { frame.close(); } catch (e) { /* ignore */ }
      }
      outputDone();
    }
  }

  self.onmessage = async (event) => {
    const { type, data } = event.data;
    switch (type) {
      case 'init':
        pipelineActive = data.initialPipelineStatus;
        if (data.channels) {
          decoderConfig.numberOfChannels = data.channels;
        }
        if (data.description) {
          decoderConfig.description = data.description;
        }
        if (data.opusUrl) opusUrl = data.opusUrl;
        await initializeDecoderInWorker();
        break;
      case 'quiet': forwardQuiet(); break;
      case 'decode':
        if (decoderAudio && decoderAudio.state === 'configured') {
          const chunk = packet(data.opusBuffer, data.timestamp || (performance.now() * 1000));
          try {
            if (currentDecodeQueueSize < 20) {
                 decoderAudio.decode(chunk); currentDecodeQueueSize++;
                 endsSound.push(!!data.quiet);
            }
          } catch (e) {
              currentDecodeQueueSize = Math.max(0, currentDecodeQueueSize - 1);
              if (decoderAudio.state === 'closed' || decoderAudio.state === 'unconfigured') await initializeDecoderInWorker();
          }
        } else if (!decoderUnavailable && (!decoderAudio || decoderAudio.state !== 'configuring')) {
          await initializeDecoderInWorker();
        }
        break;
      case 'reinitialize': await initializeDecoderInWorker(); break;
      case 'pcmPort': pcmPort = event.data.port; break;
      case 'audioIn':
        audioIn = event.data.port;
        audioIn.onmessage = (m) => {
          if (!decoderAudio || decoderAudio.state !== 'configured') return;
          const quiet = (new Uint8Array(m.data.buffer, 1, 1)[0] & ${vi}) !== 0;
          if (quiet && m.data.buffer.byteLength <= 2) { forwardQuiet(); return; }
          const frames = extractOpusFrames(m.data.buffer).filter((opus) => opus.byteLength);
          frames.forEach((opus, i) => {
            try {
              decoderAudio.decode(packet(opus, performance.now() * 1000));
              currentDecodeQueueSize++;
              endsSound.push(quiet && i === frames.length - 1);
            } catch (err) { /* a reconfiguring decoder drops the packet */ }
          });
        };
        break;
      case 'updatePipelineStatus': pipelineActive = data.isActive; break;
      case 'close':
        if (decoderAudio && decoderAudio.state !== 'closed') { try { decoderAudio.close(); } catch (e) { /* ignore */ } }
        decoderAudio = null; self.close(); break;
      default: break;
    }
  };
`,Mc=`
  let encoder = null, tsUs = 0, active = true, wirePort = null, wasm = false;
  // One Opus packet out as a 0x02 frame.
  const send = (opus) => {
    if (!active) return;
    const buf = new ArrayBuffer(1 + opus.byteLength);
    const frame = new Uint8Array(buf);
    frame[0] = 0x02;
    frame.set(opus, 1);
    if (wirePort) wirePort.postMessage(buf, [buf]);
    else self.postMessage({ type: 'chunk', buffer: buf }, [buf]);
  };
  // libopus in WASM for an engine with no AudioEncoder: the settings the
  // WebCodecs path asks for, in its default 20 ms frames, which the worklet's
  // render quanta are gathered into here.
  const wasmEncoder = async (url) => {
    const opus = await import(url);
    const enc = await opus.createEncoder({ sampleRate: 24000, channels: 1, frameSize: 480,
      application: opus.Application.RestrictedLowDelay, bitrate: ${lt} });
    const frame = new Int16Array(enc.frameSize);
    let fill = 0;
    return {
      state: 'configured',
      encode(buffer) {
        const pcm = new Int16Array(buffer);
        for (let i = 0; i < pcm.length;) {
          const n = Math.min(frame.length - fill, pcm.length - i);
          frame.set(pcm.subarray(i, i + n), fill);
          fill += n;
          i += n;
          if (fill === frame.length) { fill = 0; send(enc.encode(frame)); }
        }
      },
      close() { this.state = 'closed'; enc.free(); },
    };
  };
  const onPcm = (buffer) => {
    if (!active || !encoder || encoder.state !== 'configured') return;
    if (!buffer || !(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) return;
    if (wasm) { try { encoder.encode(buffer); } catch (err) {} return; }
    const numFrames = buffer.byteLength / 2;
    const audioData = new AudioData({ format: 's16', sampleRate: 24000, numberOfFrames: numFrames, numberOfChannels: 1, timestamp: tsUs, data: buffer });
    tsUs += Math.round(numFrames * 1e6 / 24000);
    try { encoder.encode(audioData); } catch (err) {}
    audioData.close();
  };
  self.onmessage = async (e) => {
    const m = e.data;
    if (m.type === 'pcmPort') { m.port.onmessage = (ev) => onPcm(ev.data); return; }
    if (m.type === 'wirePort') { wirePort = m.port; return; }
    if (m.type === 'init') {
      if (typeof AudioEncoder === 'undefined') {
        try {
          if (!m.opusUrl) throw new Error('no AudioEncoder and no WASM encoder to fall back on');
          const enc = await wasmEncoder(m.opusUrl);
          if (!active) { enc.close(); return; }
          encoder = enc;
          wasm = true;
          self.postMessage({ type: 'ready', wasm: true });
        } catch (err) { self.postMessage({ type: 'error', message: String(err && err.message) }); }
        return;
      }
      const base = { codec: 'opus', sampleRate: 24000, numberOfChannels: 1, bitrate: ${lt} };
      let cfg = { ...base, opus: { application: 'lowdelay' } };
      try { const s = await AudioEncoder.isConfigSupported(cfg); if (!s || !s.supported) cfg = base; } catch (err) { cfg = base; }
      try {
        encoder = new AudioEncoder({
          output: (chunk) => {
            const opus = new Uint8Array(chunk.byteLength);
            chunk.copyTo(opus);
            send(opus);
          },
          error: (err) => self.postMessage({ type: 'error', message: String(err && err.message) }),
        });
        encoder.configure(cfg);
        self.postMessage({ type: 'ready' });
      } catch (err) { self.postMessage({ type: 'error', message: String(err && err.message) }); }
      return;
    }
    if (m.type === 'pcm') { onPcm(m.buffer); return; }
    if (m.type === 'stop') { active = false; try { encoder && encoder.state !== 'closed' && encoder.close(); } catch (err) {} encoder = null; return; }
  };
`;function Nc(e){try{navigator.audioSession&&navigator.audioSession.type!==e&&(navigator.audioSession.type=e)}catch{}}async function Pc(e=!1){if(W){console.log(`Shared mode: Microphone capture blocked.`),T=!1,lc();return}if(T||ot||!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){T||=!1,lc();return}let t={withdrawn:!1},n;try{n={audio:{deviceId:dt?{exact:dt}:void 0,sampleRate:24e3,channelCount:1,echoCancellation:!0,noiseSuppression:!0,autoGainControl:!0},video:!1},Nc(`play-and-record`),ot=t;let e;try{e=await navigator.mediaDevices.getUserMedia(n)}finally{ot=null}if(t.withdrawn){e.getTracks().forEach(e=>e.stop()),Nc(`playback`);return}at=e;let r=at.getAudioTracks();if(r.length>0){let e=r[0].getSettings();!dt&&e.deviceId&&(dt=e.deviceId)}M&&M.state!==`closed`&&await M.close(),M=new AudioContext({sampleRate:24e3});try{st=M.createMediaStreamSource(at)}catch(e){if(e.name!==`NotSupportedError`)throw e;await M.close(),M=new AudioContext,st=M.createMediaStreamSource(at),console.info(`[Main] Microphone captured at ${M.sampleRate} Hz and resampled to 24 kHz, the engine refusing a 24 kHz context.`)}M.state===`suspended`&&await M.resume(),await M.audioWorklet.addModule(R(`
class MicWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.SILENCE_THRESHOLD_CHUNKS = 300;
    this.silentChunkCounter = 0;
    this.isSending = true;
    // Resampling to 24 kHz: a Hann-windowed sinc low-pass under the new
    // Nyquist, then linear interpolation between its outputs.
    this.step = sampleRate / 24000;
    if (this.step !== 1) {
      const n = 31, cut = Math.min(0.5, 10800 / sampleRate);
      const taps = Array.from({ length: n }, (_, i) => {
        const x = i - (n - 1) / 2;
        const sinc = x === 0 ? 2 * cut : Math.sin(2 * Math.PI * cut * x) / (Math.PI * x);
        return sinc * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)));
      });
      const sum = taps.reduce((a, b) => a + b, 0);
      this.taps = Float32Array.from(taps, (t) => t / sum);
      this.history = new Float32Array(n);
      this.prev = 0;
      this.at = 1;
    }
    // The encode worker's own line in: capture then reaches it whatever the
    // page's thread is doing. Until it is handed over, the page relays.
    this.out = this.port;
    this.port.onmessage = (e) => {
      if (e.data && e.data.port) this.out = e.data.port;
    };
  }
  resample(input) {
    const out = [];
    const h = this.history, taps = this.taps;
    for (let i = 0; i < input.length; i++) {
      h.copyWithin(0, 1);
      h[h.length - 1] = input[i];
      let y = 0;
      for (let k = 0; k < h.length; k++) y += taps[k] * h[k];
      for (; this.at <= 1; this.at += this.step) out.push(this.prev + (y - this.prev) * this.at);
      this.at -= 1;
      this.prev = y;
    }
    return out;
  }
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input && input[0]) {
      const inputChannelData = this.step === 1 ? input[0] : this.resample(input[0]);
      const int16Array = Int16Array.from(inputChannelData, x => x * 32767);
      const isCurrentChunkSilent = int16Array.every(item => item === 0);
      if (!isCurrentChunkSilent) {
        this.isSending = true;
        this.silentChunkCounter = 0;
      } else {
        this.silentChunkCounter++;
      }
      if (this.silentChunkCounter >= this.SILENCE_THRESHOLD_CHUNKS) {
        this.isSending = false;
      }
      if (this.isSending) {
        this.out.postMessage(int16Array.buffer, [int16Array.buffer]);
      }
    }
    return true;
  }
}
registerProcessor('mic-worklet-processor', MicWorkletProcessor);
`)),ct=new AudioWorkletNode(M,`mic-worklet-processor`);let i=URL.createObjectURL(new Blob([Mc],{type:`application/javascript`}));if(N=new Worker(i),URL.revokeObjectURL(i),N.onmessage=e=>{let t=e.data;if(t.type===`chunk`){if(!(u&&u.readyState===WebSocket.OPEN&&T))return;try{u.send(t.buffer)}catch(e){console.error(`Error sending mic Opus:`,e)}}else t.type===`ready`&&t.wasm?console.log(`[Main] Microphone encodes Opus on libopus in WASM, the engine having no AudioEncoder.`):t.type===`error`&&console.error(`Mic AudioEncoder error:`,t.message)},N.onerror=e=>console.error(`Mic encode worker error:`,e&&e.message),N.postMessage({type:`init`,opusUrl:kc()}),u&&u.connectSend){let e=new MessageChannel;ct.port.postMessage({port:e.port1},[e.port1]),N.postMessage({type:`pcmPort`,port:e.port2},[e.port2]);let t=new MessageChannel;N.postMessage({type:`wirePort`,port:t.port1},[t.port1]),u.connectSend(t.port2)}ct.port.onmessage=e=>{let t=e.data;if(N&&T&&t&&t instanceof ArrayBuffer&&t.byteLength!==0)try{N.postMessage({type:`pcm`,buffer:t},[t])}catch(e){console.error(`Mic PCM forward error:`,e)}},ct.port.onmessageerror=e=>console.error(`Error from mic worklet:`,e),st.connect(ct),T=!0,lc()}catch(n){console.error(`Failed to start microphone capture:`,n),!e&&!t.withdrawn?alert(`Microphone error: ${n.name} - ${n.message}`):Pe(n)&&(Qe=!0),Fc(),Nc(`playback`)}}function Fc(){if(ot&&(ot.withdrawn=!0),!T&&!at&&!M){T&&(T=!1,lc());return}if(at&&=(at.getTracks().forEach(e=>e.stop()),null),ct){ct.port.onmessage=null,ct.port.onmessageerror=null;try{ct.disconnect()}catch{}ct=null}if(N){try{N.postMessage({type:`stop`})}catch{}try{N.terminate()}catch{}N=null}if(st){try{st.disconnect()}catch{}st=null}M&&(M.state===`closed`?M=null:M.close().catch(e=>console.error(`Error closing mic AudioContext:`,e)).finally(()=>M=null)),Nc(`playback`),T&&(T=!1,lc())}let Ic=0;function Lc(e=!1){W||A||(A=new mr({encoderPreference:et,sendFrame:(e,t,n,r,i)=>{if(!(u&&u.readyState===WebSocket.OPEN&&Ne))return;let a=new ArrayBuffer(3+n.byteLength),o=new Uint8Array(a);o[0]=6,o[1]=e,o[2]=+!!t|((r||0)/90&3)<<1|(i?8:0),o.set(n,3);try{Ic=a.byteLength,u.send(a)}catch(e){console.error(`Error sending webcam frame:`,e)}},canSend:()=>!u||u.bufferedAmount<=Math.max(A.bitrate/8*250/1e3,Ic),onStateChange:e=>{Ne=e,lc()},onError:t=>{console.error(`Webcam capture error:`,t),e?Pe(t)&&($e=!0):alert(`Webcam error: ${t.name||`Error`} - ${t.message||t}`),Rc()}}),u&&u.connectWebcam&&A.setWireProvider(()=>{if(!u||!u.connectWebcam)return null;let e=new MessageChannel;return u.connectWebcam(e.port2),e.port1}),A.start(null))}function Rc(){A&&=(A.stop(),null),Ne&&(Ne=!1,lc())}function zc(){pt&&=(clearInterval(pt),null),mt&&=(clearInterval(mt),null),Rs(),Ys(),Sc(),!window.isCleaningUp&&(window.isCleaningUp=!0,console.log(`Cleanup: Starting cleanup process...`),W||(Fc(),Rc()),u&&(u.onopen=null,u.onmessage=null,u.onerror=null,u.onclose=null,(u.readyState===WebSocket.OPEN||u.readyState===WebSocket.CONNECTING)&&u.close(),u=null,window.selkiesTransport=null,Ha=!1),h&&(h.state!==`closed`&&h.close().catch(e=>console.error(`Cleanup error:`,e)),h=null,ac(),g=null,v=null,window.currentAudioBufferSize=0,s&&=(s.postMessage({type:`close`}),s.terminate(),null)),Tc(),cs(),dt=null,ft=null,Oi=`connecting`,ki=``,Ki=!1,Ji=!1,Y&&(Y.textContent=`Connecting...`),Y&&Y.classList.remove(`hidden`),ea&&ea.classList.remove(`hidden`),X&&(X.style.cursor=`auto`),S=!0,w=!0,T=!1,k.clear(),qe=!1,Ye=!1,window.fps=0,Xi=0,$i=performance.now(),console.log(`Cleanup: Finished cleanup process.`),window.isCleaningUp=!1)}function Bc(e=`unknown`){if(console.log(`Performing server-initiated video reset. Reason: ${e}. Current lastReceivedVideoFrameId before reset: ${Ie}`),Ie=-1,vs=null,Re=-1,u&&typeof u.resetVideoAck==`function`&&u.resetVideoAck(),console.log(`  Reset lastReceivedVideoFrameId to ${Ie}.`),Tc(),Ec(),Jt(V)&&cs(),Va&&(Va=!1,La=null,Ra=0,za=0,Ba=null,oo()),l&&c&&!Jt(V))try{l.setTransform(1,0,0,1,0,0),l.clearRect(0,0,c.width,c.height),console.log(`  Cleared canvas during server-initiated reset.`)}catch(e){console.error(`  Error clearing canvas during server-initiated reset:`,e)}}function Vc(e){u&&u.readyState===WebSocket.OPEN&&(u.send(`LOST_FRAME ${e}`),Mi.lost++)}let Hc=0;function Uc(){if(Mo)return;let e=performance.now();e-Hc<(W?1500:500)||(Hc=e,u&&u.readyState===WebSocket.OPEN&&(u.send(`REQUEST_KEYFRAME`),Mi.keyframes++))}function Wc(){if(La=null,Ra=0,za=0,Ba=null,Va=!1,$)try{$.postMessage({type:`closeDecoder`})}catch{}cs(),Hc=0,Uc()}function Gc(e,t){if(e.name===`QuotaExceededError`||e.message&&e.message.includes(`reclaimed`)){console.warn(`[initiateFallback] Ignoring soft error (Context: ${t}): Codec reclaimed by browser. Waiting for tab focus to re-initialize.`);return}if(!xr&&!window.isFallingBack&&V!==`jpeg`){xr=!0,wr=Ar=performance.now(),console.warn(`[initiateFallback] Decoder error (Context: ${t}); retrying on software decode.`,e),Nr(!0,`decoder error (${t}: ${e&&e.message||e})`),Wc();return}if(performance.now()-wr<kr){console.warn(`[initiateFallback] Ignoring decoder error (Context: ${t}) from the decoders the software switch replaced.`);return}let n=i(V);if(!W&&qt(V)&&n!==`h264`){if(jo)return;if(Uo(`${n} (refused at decode)`,n),jo){xr=!1,Nr(!1),cs();return}}if(K&&!window.isFallingBack&&!(Be>Ar)){console.warn(`[initiateFallback] Software decode put out no frame (Context: ${t}); leaving the choice of decoder to the browser.`,e),Nr(!1),wr=performance.now(),Wc();return}if(console.error(`FATAL DECODER ERROR (Context: ${t}).`,e),!window.isFallingBack){if(window.isFallingBack=!0,Nr(!1),u&&u.readyState===WebSocket.OPEN&&(u.onclose=null,u.close()),pt&&=(clearInterval(pt),null),W)console.log(`Shared client fallback: Reloading page to re-sync with the stream.`),Y&&(Y.textContent=`A video error occurred. Reloading to re-sync with the stream...`,Y.classList.remove(`hidden`));else{let n=parseInt(window.localStorage.getItem(Ir)||`0`);n++,_r(Ir,n.toString());let r=`decoder crash ${n} in this browser (${t}: ${e&&e.message||e})`,i=null;n>=3?i=`jpeg`:V===`jpeg`?_r(Ir,`0`):i=`h264enc`,i&&pa(i,r),ha(r),console.log(`Primary client fallback, ${r}: this tab reloads on safe defaults${i?` and the ${i} encoder`:``}.`),Y&&(Y.textContent=`A critical video error occurred. Resetting to default settings and reloading...`,Y.classList.remove(`hidden`))}setTimeout(()=>{window.location.reload()},3e3)}}function Kc(){return ss(),window.isSecureContext?(window.VideoDecoder===void 0?(console.warn(`VideoDecoder API unavailable: the stream is pinned to the jpeg encoder.`),qc()):console.log(`Pre-flight checks passed: Secure context and VideoDecoder API are available.`),!0):(console.error(`FATAL: Not in a secure context. WebCodecs require HTTPS.`),Y&&(Y.textContent=`Error: This application requires a secure connection (HTTPS). Please check the URL.`,Y.classList.remove(`hidden`)),ea&&ea.classList.add(`hidden`),!1)}function qc(){V=`jpeg`,pa(`jpeg`,`no WebCodecs VideoDecoder`)}window.addEventListener(`beforeunload`,zc),window.webrtcInput=null}var Si=`webrtc`,Ci=`websockets`,wi=window.location.origin+window.location.pathname,Ti=ke(),Ei=e=>`${Ti}_${e}`,Di=(e,t)=>{try{localStorage.setItem(e,t)}catch(t){console.warn(`Selkies: could not persist '${e}' to localStorage:`,t)}};(function(){try{if(typeof localStorage>`u`)return;let e=``;for(let t=0;t<wi.length;t++){let n=wi.charCodeAt(t);e+=n>=46&&n<=95||n>=97&&n<=122?wi[t]:`_`}let t=e+`?`,n=[];for(let e=0;e<localStorage.length;e++){let r=localStorage.key(e);r&&r.startsWith(t)&&n.push(r)}if(n.forEach(e=>localStorage.removeItem(e)),n.length&&console.log(`Selkies: removed ${n.length} stale token-scoped localStorage keys.`),e===Ti)return;let r=`${Ti}_storage_key_migrated`;if(localStorage.getItem(r)!==null)return;let i=`${e}_`,a=`${Ti}_`,o=[];for(let e=0;e<localStorage.length;e++){let t=localStorage.key(e);t!==null&&o.push(t)}let s=o.some(e=>e.startsWith(a)),c=o.filter(e=>e.startsWith(i));if(!s&&c.length>0){for(let e of c){let t=a+e.slice(i.length);if(localStorage.getItem(t)===null){let n=localStorage.getItem(e);n!==null&&Di(t,n)}}console.log(`Migrated ${c.length} setting(s) from old storage prefix "${i}" to "${a}".`)}Di(r,`1`)}catch(e){console.warn(`Storage key migration skipped due to error:`,e)}})();var Oi=null;function ki(){let e=typeof window<`u`&&window.__SELKIES_STREAMING_MODE__?window.__SELKIES_STREAMING_MODE__:void 0,t=localStorage.getItem(Ei(`stream_mode`)),n=e||t||Ci;return console.log(`Streaming mode determined to be: ${n}`),n}function Ai(e){if(e.origin!==window.location.origin)return;let t=e.data;if(t.mode!==void 0&&t.type===`mode`){if(![Si,Ci].includes(t.mode))return;console.log(`Switching streaming mode to: ${t.mode}`),Di(Ei(`stream_mode`),t.mode),setTimeout(()=>{window.location.reload()},2e3)}}function q(e){switch(Di(Ei(`stream_mode`),e),e){case Si:Oi=ii(),Oi.initialize();break;case Ci:Oi=xi();break;default:throw Error(`Invalid client mode: ${e} received, aborting`)}}typeof window<`u`&&(window.addEventListener(`message`,Ai),window.selkiesCoreInitialize=function(){Ie(),q(ki())}),typeof window<`u`&&!window.__SELKIES_DEFER_INITIALIZATION&&window.selkiesCoreInitialize();