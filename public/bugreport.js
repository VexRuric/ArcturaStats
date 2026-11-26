/* Bug report engine: reads Unreal game logs, crash bundles (log, CrashContext xml, ini, minidump) and checks them against each other and
   against stored match ledgers. Pure functions, no page access, so it runs in the browser and in Node (module.exports) for tests.
   Nothing here uploads anything: the page keeps the raw files in the browser and only a short report is ever saved. */
(function (root) {
  'use strict';
  var SEV = ['critical', 'high', 'medium', 'low', 'info'];
  var SEVW = { critical: 100, high: 30, medium: 10, low: 3, info: 1 };

  /* ---------- small helpers ---------- */
  function scrub(s) {
    if (s == null) return s;
    return String(s).replace(/([A-Za-z]:[\\\/]+Users[\\\/]+)[^\\\/\s"'<>]+/gi, '$1<user>').replace(/\b[0-9a-f]{32}\b/gi, '<id>');
  }
  function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function hash8(s) { var h = 0x811c9dc5; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return ('00000000' + h.toString(16)).slice(-8); }
  function norm(msg) {
    return String(msg).replace(/_C_\d+/g, '_C_#').replace(/UAID_[0-9A-Fa-f]+(_\d+)?/g, 'UAID_#').replace(/0x[0-9a-fA-F]+/g, '0x#')
      .replace(/\b[0-9a-fA-F]{32}\b/g, '#').replace(/-?\d+(\.\d+)?/g, '#').replace(/\s+/g, ' ').trim().slice(0, 220);
  }
  function r1(n) { return Math.round(n * 10) / 10; }
  function fmtDur(s) { s = Math.round(s); var m = Math.floor(s / 60); return m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : m ? m + 'm ' + (s % 60) + 's' : s + 's'; }
  function tally(o, k, cap) { if (!k) return; if (o[k] != null) o[k]++; else if (Object.keys(o).length < (cap || 40)) o[k] = 1; }
  function topOf(o, n) { return Object.keys(o).sort(function (a, b) { return o[b] - o[a]; }).slice(0, n || 5).map(function (k) { return { k: k, n: o[k] }; }); }
  function shortMap(p) { p = String(p || '').split('?')[0]; p = p.replace(/^.*GameNetDriver:\d+/, ''); var m = /([^\/.]+)(?:\.[^\/.]+)?$/.exec(p); return m ? m[1] : p; }
  function alnum(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

  /* ---------- the catalog of known problems: what a log line means and what it breaks ---------- */
  /* test runs on "Category|message"; extract returns a detail to count (a tag, an asset, a class); extra reads the lines under the message. */
  var RULES = [
    { id: 'fatal', re: /^[^|]*\|(?:\w+: )?(?:appError called|Fatal error|Assertion failed|Ensure condition failed|Unhandled Exception|Critical error)/, any: 1, sev: 'critical', area: 'crash', title: 'Fatal error, assertion or ensure', why: 'The engine hit a condition it could not continue from.', fix: 'Open the crash bundle for the same time. The call stack names the code that failed.' },
    { id: 'recursion', re: /^LogScript\|Infinite script recursion/, sev: 'high', area: 'blueprint', title: 'Blueprint calls itself without end', why: 'A Blueprint function loops on itself until the engine stops it. The game freezes while it happens and it can end in a crash.', fix: 'Open the Blueprint named in the script call stack and break the loop (a setter that fires its own change event is the usual cause).', extra: function (l) { var m = /^\s*(\S+_C)\s/.exec(l); return m ? m[1] : null; } },
    { id: 'none-prop', re: /^LogScript\|Accessed None trying to read \(real\) property (\S+) in (.+)$/, sev: function (i) { return i.top && /^(GA_|GE_|BP_Player|BP_Aeon.*Character)/.test(i.top) ? 'high' : 'medium'; }, area: 'blueprint', title: 'Blueprint reads a variable that is empty (Accessed None)', why: 'A Blueprint used an object reference that was never set or was already destroyed. Whatever it was meant to do (a UI element, an ability effect) silently does nothing.', fix: 'Validate the reference (IsValid) before use or make sure it is set earlier. The property named is the one that was empty.', extract: function (m) { var c = String(m[2]).replace(/\s*(not an UClass|\.).*$/, '').trim(); return c ? m[1] + ' in ' + c.slice(0, 40) : m[1]; } },
    { id: 'none', re: /^LogScript\|Accessed None\s*$/, sev: function (i) { return i.top && /^(GA_|GE_|BP_Player)/.test(i.top) ? 'high' : 'medium'; }, area: 'blueprint', title: 'Blueprint uses an empty object (Accessed None)', why: 'A Blueprint called a function on an object that is None, so that step is skipped. When the class is an ability the player-visible effect can be missing.', fix: 'Find the Blueprint in the lines under the message and validate the reference before it is used.', extra: function (l) { var m = /^\s*(\S+_C)\s/.exec(l); return m ? m[1] : null; } },
    { id: 'script-array', re: /^LogScript\|Script Msg: Attempted to access index (\d+) from array '([^']+)'/, sev: 'medium', area: 'blueprint', title: 'Blueprint reads past the end of an array', why: 'A Blueprint asked for an item that is not in the list (the list was empty or shorter than expected).', fix: 'Check the array length (or use a safe Get) before reading an index.', extract: function (m) { return m[2]; } },
    { id: 'script-switch', re: /^LogScript\|Switch statement failed to match case/, sev: 'low', area: 'blueprint', title: 'Blueprint switch has no case for a value', why: 'A Switch node received a value it has no pin for, so nothing runs for it.', fix: 'Add the missing case or a default pin.' },
    { id: 'script-niagara', re: /^LogScript\|UGameplayStatics::SpawnNiagaraEmitterAttached: NULL AttachComponent/, sev: 'low', area: 'vfx', title: 'Effect spawned with nothing to attach to', why: 'A visual effect was asked to attach to a component that does not exist, so the effect does not show.', fix: 'Pass a valid mesh or scene component to the Spawn System Attached node.' },
    { id: 'gas-removetag', re: /^LogAbilitySystem\|FMinimalReplicationTagCountMap::RemoveTag called on Tag (\S+) that wasn't in the tag map/, sev: 'medium', area: 'gameplay', title: 'Ability tag removed that was never added (replication)', why: 'A replicated gameplay tag is removed on a machine that never saw it added. An ability end or cancel runs twice, or runs before the add arrived. The state of that ability can desync between host and client.', fix: 'Check the ability\'s End and Cancel paths and that the tag comes from a replicated effect, not a local add.', extract: function (m) { return m[1]; } },
    { id: 'gas-noauth', re: /^LogAbilitySystem\|RemoveActiveGameplayEffect called without Authority when attempting to remove (\S+)/, sev: 'low', area: 'gameplay', title: 'Effect removed on the client without authority', why: 'A client tried to remove a gameplay effect only the server may remove (prediction without a matching key).', fix: 'Remove the effect on the server, or enable predictive effect flags if this is intended.', extract: function (m) { return m[1].replace(/\.$/, ''); } },
    { id: 'ability-fail-normal', re: /^LogAeonAbilitySystem\|Ability \S*?\.(GA_[A-Za-z0-9_]+?)_C_\d+ failed to activate \(tags: .*?TagName="Aeon\.Ability\.Fail\.(Cooldown|BlockedTag|Cost)"/, sev: 'info', area: 'gameplay', title: 'Ability pressed but blocked (cooldown, blocking tag or cost)', why: 'Usually a player pressing an ability while it is on cooldown, blocked by another state or out of resources, which is expected. It only matters if a player says the ability should have worked.', fix: 'Nothing, unless the count is far out of line for how often that ability is used (compare the cast count in the ledger).', extract: function (m) { return m[1] + ' (' + m[2] + ')'; } },
    { id: 'ability-fail', re: /^LogAeonAbilitySystem\|Ability \S*?\.(GA_[A-Za-z0-9_]+?)_C_\d+ failed to activate \(tags: .*?TagName="([^"]+)"/, sev: 'medium', area: 'gameplay', title: 'Ability failed to activate for an unexpected reason', why: 'The ability system refused to start the ability and the reason is not a plain cooldown, blocking tag or cost. CanActivateAbility means the ability\'s own check said no (for example an auto respawn that could not run).', fix: 'Check the ability\'s CanActivateAbility and the state its owner was in.', extract: function (m) { return m[1] + ' (' + m[2].replace(/^Aeon\.Ability\.Fail\./, '') + ')'; } },
    { id: 'cooldown-tag', re: /^LogAeonGameplayAbility\|\[(GA_[A-Za-z0-9_]+?)_C_\d+\] BroadcastCooldown: AbilityTag is invalid/, sev: 'medium', area: 'gameplay', title: 'Cooldown cannot be shown, ability has no tag', why: 'The ability tries to tell the HUD about its cooldown but has no AbilityTag set, so its cooldown does not show.', fix: 'Set the Ability Tag on the ability (class defaults).', extract: function (m) { return m[1]; } },
    { id: 'cooldown-row', re: /^LogAeonGameplayAbility\|\[(BP_[A-Za-z0-9_]+?)_C_\d+\]->\[(GA_[A-Za-z0-9_]+?)_C_\d+\] ApplyCooldown failed to get ability data row: (\S+)/, sev: 'medium', area: 'data', title: 'Ability data row missing, cooldown not applied', why: 'The ability looked for its row in the ability data table and found none, so no cooldown is applied for that class.', fix: 'Add the row to the ability data table for that class, or point the ability at an existing row.', extract: function (m) { return m[2] + ' on ' + m[1].replace(/^BP_Player_/, '') + ' (row ' + m[3] + ')'; } },
    { id: 'datatable-row', re: /^LogDataTable\|UDataTable::FindRow : '([^']+)' requested row '([^']+)' not in DataTable '[^']*?([A-Za-z0-9_]+)\.[A-Za-z0-9_]+'/, sev: 'medium', area: 'data', title: 'Data table row missing', why: 'Code looked up a row that is not in the table, so it falls back to nothing (a toast loses its icon or category, a stat reads zero).', fix: 'Add the row to the table or stop asking for it.', extract: function (m) { return "row '" + m[2] + "' in " + m[3]; } },
    { id: 'vitals-set', re: /^LogAeonPlayerState\|RemoveStrayVitalsSets: unregistered extra Vitals set/, sev: 'medium', area: 'gameplay', title: 'Player state has a duplicate Vitals attribute set', why: 'The PlayerState Blueprint creates a Vitals attribute set that the code already registers, so two sets exist. Health values can be read from the wrong one.', fix: 'Remove the Vitals set from the PlayerState Blueprint, as the message says.' },
    { id: 'ak-null', re: /^LogAkAudio\|Failed to post invalid AkAudioEvent on component '([^']+)'/, sev: 'medium', area: 'audio', title: 'Sound event missing, nothing plays', why: 'Something tried to play a sound but its Wwise event is empty or did not load, so the sound is silent.', fix: 'Assign the missing AkAudioEvent on that component, or check the Wwise bank loaded.', extract: function (m) { return m[1]; } },
    { id: 'wwise-voice', re: /^LogWwiseMonitor\|Voice Starvation/, sev: 'low', area: 'audio', title: 'Audio ran out of voices', why: 'Wwise could not start a voice in time, so a sound may drop out.', fix: 'Raise the voice limit or the audio thread budget, or lower how many sounds fire at once.' },
    { id: 'audio-device', re: /^LogAudio\|Audio Device Manager Initialization Failed/, sev: 'medium', area: 'audio', title: 'Audio device did not start', why: 'The engine audio device failed to initialize, so engine audio is off (Wwise may still run).', fix: 'Check the audio output device on the machine, then compare with a machine where it works.' },
    { id: 'skeleton-bones', re: /^LogAnimation\|USkeleton::BuildLinkup: The Skeleton (\S+), is missing bones that SkeletalMesh (\S+) needs/, sev: 'low', area: 'art', title: 'Mesh needs bones its skeleton does not have', why: 'A cosmetic mesh was made for a different rig than the one it is attached to, so parts of it will not animate.', fix: 'Re-export the mesh on the right skeleton or add the bones.', extract: function (m) { return m[2].replace(/\d+/g, '#'); } },
    { id: 'montage-section', re: /^LogAnimMontage\|JumpToSectionName (.+?) bEndOfSection: \d+ failed for Montage (\S+)/, sev: 'low', area: 'animation', title: 'Animation jumps to a section that is not there', why: 'The dodge or dash asks the montage for a section name it does not have, so the animation skips ahead.', fix: 'Rename the section in the montage or fix the name the ability uses.', extract: function (m) { return m[2] + ' (' + m[1] + ')'; } },
    { id: 'nanite-material', re: /^LogStaticMesh\|Invalid material \[([^\]]+)\] used on Nanite static mesh \[([^\]]+)\]/, sev: 'low', area: 'art', title: 'Material not allowed on a Nanite mesh', why: 'Nanite only supports opaque or masked materials. The mesh falls back to the regular renderer, and the log is flooded with this line every time it loads.', fix: 'Turn Nanite off on the mesh or use an opaque/masked material.', extract: function (m) { return m[1] + ' on ' + m[2]; } },
    { id: 'shader-wait', re: /^LogShaderLibrary\|Spent [\d.]+ ms in a blocking wait for shader preload/, sev: 'low', area: 'performance', title: 'Frame waited for shaders to load', why: 'A frame stalled while shaders loaded, which shows as a hitch.', fix: 'Precache the PSOs for the first-seen effects or load them before the match starts.' },
    { id: 'net-failure', re: /^LogNet\|UEngine::BroadcastNetworkFailure: FailureType = (\w+), ErrorString = ([^,]+)/, sev: 'medium', area: 'network', title: 'Network failure', why: 'The connection to the host ended. At the end of a match that is how the host closes the session; in the middle of a match it is a dropped player.', fix: 'Compare the time with the match end in the ledger (see the cross-checks).', extract: function (m) { return m[1] + ': ' + m[2]; } },
    { id: 'relic-rpc', re: /^LogNet\|UNetDriver::ProcessRemoteFunction: No owning connection for actor (BP_RelicSpawner\S*)\. Function (\w+)/, sev: 'medium', area: 'gameplay', title: 'Relic spawner call dropped (no owning connection)', why: 'A relic spawner calls a server function from a place with no owner, so the engine drops the call and the relic may not spawn.', fix: 'Make the spawn run on the server, or mark the call as run-on-server from an owned actor.', extract: function (m) { return m[2]; } },
    { id: 'net-resolve', re: /^LogSockets\|GetAddressInfo failed to resolve host/, sev: 'low', area: 'network', title: 'Host name could not be resolved', why: 'The game asked the network for an address that does not exist. On startup it means the launch arguments were read as a map address.', fix: 'See the launch argument check.' },
    { id: 'voice-iface', re: /^AdvancedFriendsInterfaceLog\|UAdvancedFriendsInstance Failed to get voice interface/, sev: 'low', area: 'network', title: 'Voice chat interface missing', why: 'The online subsystem has no voice interface, so voice chat is off.', fix: 'Enable the voice interface in the online subsystem settings if voice is wanted.' },
    { id: 'eos-name', re: /^LogEOSSDK\|LogEOSUserInfo: FUserInfoClient::CopyBestDisplayNamePrivate Unable to find linked account/, sev: 'info', area: 'network', title: 'Epic account has no linked display name', why: 'An Epic Online Services user has no linked platform account, so the name falls back. Names in the stats can differ from the in-game name.', fix: 'Nothing to fix in game. Check how player names are read for the stats.' }
  ];
  /* the area of a problem no rule knows, from the log category */
  function areaOf(cat) {
    var c = String(cat);
    if (/Script|Blueprint/i.test(c)) return 'blueprint';
    if (/Ak|Wwise|Audio/i.test(c)) return 'audio';
    if (/Anim/i.test(c)) return 'animation';
    if (/Niagara|Particle|Cascade/i.test(c)) return 'vfx';
    if (/DataTable|Config|DataAsset/i.test(c)) return 'data';
    if (/Net|Socket|EOS|Online|Session|Handshake|Hosting|Voice/i.test(c)) return 'network';
    if (/UI|Widget|Slate|Toast|Umg|Minimap|Hud/i.test(c)) return 'ui';
    if (/Ability|Gameplay|Aeon|Player|Team|Sprint|Combat/i.test(c)) return 'gameplay';
    if (/StaticMesh|SkeletalMesh|Material|Texture|Landscape|Nanite|Lumen|Mesh/i.test(c)) return 'art';
    if (/RHI|D3D|Shader|PSO|Render|Stat|Memory|Hitch/i.test(c)) return 'performance';
    if (/Stream|Package|Linker|Asset|Pak|Load/i.test(c)) return 'assets';
    return 'other';
  }
  function ruleFor(cat, level, msg) {
    var s = cat + '|' + msg;
    for (var i = 0; i < RULES.length; i++) { var m = RULES[i].re.exec(RULES[i].any ? cat + '|' + (level ? level + ': ' : '') + msg : s); if (m) return { rule: RULES[i], m: m }; }
    return null;
  }
  var SYSMOD = /^(ntdll|kernel32|kernelbase|ucrtbase|user32|gdi32|gdi32full|win32u|advapi32|sechost|rpcrt4|combase|ole32|oleaut32|shell32|shlwapi|shcore|msvcrt|msvcp_win|msvcp140|vcruntime140(_1)?|ws2_32|winmm|bcrypt|bcryptprimitives|crypt32|imm32|setupapi|cfgmgr32|version|dwmapi|uxtheme|comctl32|comdlg32|netapi32|iphlpapi|winhttp|propsys|dbghelp|psapi|powrprof|pdh|dxgi|d3d11|d3d12|dxcore|dsound|opengl32|glu32|umpdc|netutils|srvcli|msdmo|resampledmo|winmmbase|uiautomationcore|tbbmalloc|kernel\.appcore|wldap32|mswsock|nsi|dnsapi|ntmarta)$/i;
  function modOwner(n) { var b = String(n).replace(/\.(dll|exe)$/i, ''); if (/^AeonVersus/i.test(b)) return 'game'; if (/UE4SS|ue4ss/i.test(b)) return 'mod'; if (SYSMOD.test(b) || /^(api-ms|ext-ms)/i.test(b)) return 'system'; if (/^(nv|amd|ig|atig|d3d|vulkan)/i.test(b)) return 'driver'; return 'other'; }

  /* ---------- Unreal game log ---------- */
  var LINE = /^\[(\d{4})\.(\d\d)\.(\d\d)-(\d\d)\.(\d\d)\.(\d\d):(\d{3})\]\[\s*(\d+)\]([A-Za-z0-9_]+): ?(.*)$/;
  function parseGameLog(text) {
    text = text.replace(/^﻿/, '');
    var lines = text.split(/\r?\n/), n = lines.length, i;
    var R = { kind: 'game', lines: n, chars: text.length, header: {}, counts: { error: 0, warning: 0, fatal: 0, display: 0, other: 0 }, phases: [], players: {}, nets: [], metrics: { pso: 0 }, exit: { clean: false }, guid: '', browse: [], cats: {} };
    var issues = {}, order = [], t0 = null, last = null, lastT = 0, cur = null, pend = null, ph = -1, seen = 0;
    function setPhase(kind, map, t, via) {
      if (cur && cur.map === map && cur.kind === kind) return;
      if (cur) cur.t1 = t;
      cur = { i: R.phases.length, kind: kind, map: map, t0: t, t1: null, via: via, errors: 0, warnings: 0 }; R.phases.push(cur); ph = cur.i;
    }
    function kindOf(map) { return /lobby|startmenu|menu/i.test(map) ? 'lobby' : /untitled|^temp/i.test(map) ? 'transit' : 'match'; }
    for (i = 0; i < n; i++) {
      var ln = lines[i], mm = LINE.exec(ln), cat, rest, t;
      if (!mm) {
        /* header lines, or the lines under a message (stack lines, asset paths) */
        var op = /^Log file open, (.*)$/.exec(ln); if (op) R.header.openLocal = op[1];
        var cl = /^Log file closed, (.*)$/.exec(ln); if (cl) R.header.closeLocal = cl[1];
        var g = /Session CrashGUID >\s+(UECC-\S+)/.exec(ln); if (g) R.guid = g[1];
        if (!ln) continue;
        if (/^[\t ]/.test(ln) && last) {
          if (pend && pend.rule.extra) { tally(pend.issue.det, pend.rule.extra(ln), 40); pend = null; }
          if (last.extra && last.extra.length < 6 && last.n <= 3) last.extra.push(clip(scrub(ln.trim()), 200));
        }
        continue;
      }
      seen++; pend = null;
      t = Date.UTC(+mm[1], mm[2] - 1, +mm[3], +mm[4], +mm[5], +mm[6]) + +mm[7];
      if (t0 === null) { t0 = t; R.start = t; }
      lastT = t; cat = mm[9]; rest = mm[10];
      var lvm = /^(Error|Warning|Fatal|Display|Verbose|VeryVerbose|Log): ?/.exec(rest), level = lvm ? lvm[1] : '', msg = lvm ? rest.slice(lvm[0].length) : rest;
      var sec = (t - t0) / 1000;
      R.cats[cat] = (R.cats[cat] || 0) + 1;
      last = null;
      /* header facts */
      if (cat === 'LogCsvProfiler') { var hm = /Metadata set : (\w+)="([^"]*)"/.exec(msg); if (hm && hm[1] !== 'loginid' && !R.header[hm[1]]) R.header[hm[1]] = scrub(hm[2]); }
      else if (cat === 'LogNetVersion') { var nv = /^(\S+) ([\d.]+), NetCL: (\d+)/.exec(msg); if (nv && !R.header.netVersion) R.header.netVersion = nv[1] + ' ' + nv[2] + ', NetCL ' + nv[3]; }
      else if (cat === 'LogD3D12RHI' && /^Found D3D12 adapter 0: /.test(msg) && !R.header.gpu) R.header.gpu = msg.replace(/^Found D3D12 adapter 0: /, '').replace(/ \(VendorId.*$/, '');
      else if (cat === 'LogRHI' && /^\s*Driver Version: /.test(msg) && !R.header.driver) R.header.driver = msg.replace(/^\s*Driver Version: /, '').replace(/ \(.*$/, '');
      else if (cat === 'LogExit' && /^Exiting\./.test(msg)) R.exit.clean = true;
      else if (cat === 'LogPSOHitching') { var ps = /Encountered (\d+) PSO creation hitches/.exec(msg); if (ps) R.metrics.pso = +ps[1]; }
      else if (cat === 'LogLoad') {
        var lm = /^LoadMap: (.*)$/.exec(msg); if (lm) { var mp = shortMap(lm[1]); R.nets.push({ t: r1(sec), k: 'load', v: mp + (/\?closed/.test(lm[1]) ? ' (closed)' : '') }); setPhase(kindOf(mp), mp, sec, /\?closed/.test(lm[1]) ? 'host closed' : 'load'); if (/\?closed/.test(lm[1])) cur.afterClose = true; }
        var tk = /^Took ([\d.]+) seconds to LoadMap/.exec(msg); if (tk && cur) cur.loadSec = +tk[1];
        var tt = /^\(Engine Initialization\) Total time: ([\d.]+) seconds/.exec(msg); if (tt) R.header.initSec = +tt[1];
      }
      else if (cat === 'LogWorld') {
        var st = /^SeamlessTravel to: (.*)$/.exec(msg); if (st) { var mp2 = shortMap(st[1]); R.nets.push({ t: r1(sec), k: 'travel', v: mp2 }); setPhase(kindOf(mp2), mp2, sec, 'travel'); }
        var sf = /SeamlessTravel finished in ([\d.]+) seconds/.exec(msg); if (sf && cur) cur.travelSec = +sf[1];
      }
      else if (cat === 'LogNet' && /^Browse: (.*)$/.test(msg)) { var br = /^Browse: (.*)$/.exec(msg)[1]; if (R.browse.length < 6) R.browse.push(scrub(br.split('?')[0])); }
      else if (cat === 'LogAeonGameState') {
        var pn = /player=(.+?) AssignedTeamId=(-?\d+)/.exec(msg) || /\bPlayer=(.+?) TeamIndex=(-?\d+)/.exec(msg);
        if (pn && pn[1] !== 'Player' && pn[1].length < 40) { var P = R.players[pn[1]] || (R.players[pn[1]] = { name: pn[1], ph: {}, team: +pn[2] }); P.ph[ph] = 1; if (+pn[2] >= 0) P.team = +pn[2]; }
      }
      if (!level || level === 'Display' || level === 'Log' || level === 'Verbose' || level === 'VeryVerbose') {
        if (level === 'Display') R.counts.display++;
        /* a few plain lines are problems all the same */
        if (cat === 'LogNet' && /^Browse: /.test(msg)) { /* checked at the end from R.browse */ }
        continue;
      }
      /* "Script call stack:" and "Script Msg called by:" only introduce the lines under the Blueprint warning just before them: not counted again */
      if (cat === 'LogScript' && /^(Script call stack:|Script Msg called by:)/.test(msg)) { last = R.__lastScript || null; continue; }
      var lc = level === 'Error' ? 'error' : level === 'Warning' ? 'warning' : 'fatal';
      R.counts[lc]++;
      if (cur) { if (lc === 'error' || lc === 'fatal') cur.errors++; else cur.warnings++; }
      var hit = ruleFor(cat, level, msg), rule = hit ? hit.rule : null, sig = (rule ? rule.id : cat + ':' + level) + '|' + norm(msg), is = issues[sig];
      if (!is) {
        is = issues[sig] = { key: 'lg:' + hash8(sig), id: rule ? rule.id : 'generic', cat: cat, level: lc, sev: rule ? null : (lc === 'fatal' ? 'critical' : lc === 'error' ? 'medium' : 'low'), area: rule ? rule.area : areaOf(cat), title: rule ? rule.title : clip(cat + ': ' + norm(msg), 110), why: rule ? rule.why : '', fix: rule ? rule.fix : '', n: 0, first: r1(sec), last: r1(sec), ph: {}, det: {}, samples: [], extra: [], rule: rule };
        order.push(is);
      }
      is.n++; is.last = r1(sec); is.ph[ph] = (is.ph[ph] || 0) + 1;
      if (is.samples.length < 2 && is.samples.indexOf(clip(scrub(msg), 300)) < 0) is.samples.push(clip(scrub(msg), 300));
      if (rule && rule.extract && hit.m) tally(is.det, rule.extract(hit.m), 40);
      if (rule && rule.extra) pend = { issue: is, rule: rule };
      last = is; if (cat === 'LogScript') R.__lastScript = is;
    }
    R.end = lastT; R.durSec = t0 === null ? 0 : (lastT - t0) / 1000;
    if (cur) cur.t1 = R.durSec;
    /* the wall clock of the machine that wrote the log: header local time against the first UTC stamp */
    var ol = /^(\d+)\/(\d+)\/(\d+) (\d+):(\d+):(\d+)/.exec(R.header.openLocal || '');
    if (ol && t0 !== null) { var loc = Date.UTC(2000 + +ol[3], +ol[1] - 1, +ol[2], +ol[4], +ol[5], +ol[6]); R.tzMin = Math.round((loc - Math.floor(t0 / 1000) * 1000) / 60000 / 15) * 15; } else R.tzMin = 0;
    R.wallStart = t0 === null ? 0 : t0 + R.tzMin * 60000;
    delete R.__lastScript;
    /* finish each issue: severity by top detail, order by weight */
    var out = order.map(function (is) {
      is.top = topOf(is.det, 1)[0] ? topOf(is.det, 1)[0].k : '';
      var sev = is.sev || (typeof is.rule.sev === 'function' ? is.rule.sev(is) : is.rule.sev);
      var o = { key: is.key, id: is.id, cat: is.cat, level: is.level, sev: sev, area: is.area, title: is.title, why: is.why, fix: is.fix, n: is.n, first: is.first, last: is.last, ph: is.ph, det: topOf(is.det, 8), samples: is.samples, extra: is.extra };
      o.score = SEVW[sev] * Math.log10(is.n + 9); return o;
    }).sort(function (a, b) { return b.score - a.score; });
    R.issues = out; R.total = n;
    R.players = Object.keys(R.players).map(function (k) { return R.players[k]; });
    R.phases.forEach(function (p) { p.t0 = r1(p.t0); p.t1 = p.t1 == null ? r1(R.durSec) : r1(p.t1); });
    return R;
  }

  /* ---------- Unreal crash context (xml), ini, and Windows minidump ---------- */
  function xmlTag(x, tag) { var m = new RegExp('<' + tag.replace(/\./g, '\\.') + '>([\\s\\S]*?)</' + tag.replace(/\./g, '\\.') + '>').exec(x); return m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim() : ''; }
  function frames(block) {
    var o = [];
    String(block || '').split(/\r?\n/).forEach(function (l) { var m = /^\s*(\S+)\s+0x([0-9a-fA-F]+) \+ ([0-9a-fA-F]+)/.exec(l); if (m) o.push({ mod: m[1], base: m[2], off: m[3], owner: modOwner(m[1]) }); });
    return o;
  }
  function parseCrashXml(x) {
    if (!/<FGenericCrashContext>/.test(x)) throw new Error('not a crash context');
    var C = { kind: 'xml', guid: xmlTag(x, 'CrashGUID'), type: xmlTag(x, 'CrashType'), error: xmlTag(x, 'ErrorMessage'), isEnsure: xmlTag(x, 'IsEnsure') === 'true', isAssert: xmlTag(x, 'IsAssert') === 'true', isStall: xmlTag(x, 'IsStall') === 'true',
      secsSinceStart: +xmlTag(x, 'SecondsSinceStart') || 0, game: xmlTag(x, 'GameName'), exe: xmlTag(x, 'ExecutableName'), config: xmlTag(x, 'BuildConfiguration'), engine: xmlTag(x, 'EngineVersion'), build: xmlTag(x, 'BuildVersion'),
      cmd: scrub(xmlTag(x, 'CommandLine')), mode: xmlTag(x, 'EngineMode'), baseDir: scrub(xmlTag(x, 'BaseDir')), pid: +xmlTag(x, 'ProcessId') || 0, hash: xmlTag(x, 'PCallStackHash'),
      os: xmlTag(x, 'Misc.OSVersionMajor'), cpu: xmlTag(x, 'Misc.CPUBrand'), gpu: xmlTag(x, 'Misc.PrimaryGPUBrand'), cores: +xmlTag(x, 'Misc.NumberOfCores') || 0, ramGB: +xmlTag(x, 'MemoryStats.TotalPhysicalGB') || 0, oom: xmlTag(x, 'MemoryStats.bIsOOM') === '1',
      rhi: { name: xmlTag(x, 'RHI.RHIName'), adapter: xmlTag(x, 'RHI.AdapterName'), driver: xmlTag(x, 'RHI.UserDriverVersion'), featureLevel: xmlTag(x, 'RHI.FeatureLevel'), dred: xmlTag(x, 'RHI.DRED'), denylisted: xmlTag(x, 'RHI.DriverDenylisted') },
      deviceProfile: xmlTag(x, 'DeviceProfile.Name'), gameState: xmlTag(x, 'GameStateName'), userDesc: xmlTag(x, 'UserDescription'), anticheat: xmlTag(x, 'Misc.AnticheatProvider'), numClients: xmlTag(x, 'NumClients'), replication: xmlTag(x, 'ReplicationModel') };
    var pc = /<PCallStack>([\s\S]*?)<\/PCallStack>/.exec(x); C.stack = frames(pc && pc[1]);
    C.callStack = frames(xmlTag(x, 'CallStack'));
    C.threads = []; var re = /<Thread>([\s\S]*?)<\/Thread>/g, m;
    while ((m = re.exec(x))) { var b = m[1], cs = /<CallStack>([\s\S]*?)<\/CallStack>/.exec(b); C.threads.push({ id: +xmlTag(b, 'ThreadID') || 0, name: xmlTag(b, 'ThreadName'), crashed: xmlTag(b, 'IsCrashed') === 'true', frames: frames(cs && cs[1]).slice(0, 24) }); }
    var em = /^Unhandled Exception: (\w+)(?: (reading|writing|executing)? ?address (0x[0-9a-fA-F]+))?/.exec(C.error); C.exc = em ? { name: em[1], access: em[2] || '', addr: em[3] || '' } : { name: '', access: '', addr: '' };
    return C;
  }
  function parseCrashIni(t) { var o = {}, sec = ''; String(t).split(/\r?\n/).forEach(function (l) { var s = /^\[(.+)\]/.exec(l); if (s) { sec = s[1]; return; } var kv = /^([^=;#]+)=(.*)$/.exec(l); if (kv) o[kv[1].trim()] = kv[2].trim(); }); return { kind: 'ini', section: sec, values: o }; }
  var EXC = { 0xc0000005: 'ACCESS_VIOLATION', 0xc00000fd: 'STACK_OVERFLOW', 0xc0000094: 'INT_DIVIDE_BY_ZERO', 0xc000001d: 'ILLEGAL_INSTRUCTION', 0xc0000374: 'HEAP_CORRUPTION', 0x80000003: 'BREAKPOINT', 0xc0000409: 'STACK_BUFFER_OVERRUN', 0xe06d7363: 'C++ EXCEPTION', 0xc0000017: 'NO_MEMORY' };
  function fmtGuid(dv, o) { var h = function (v, n) { return ('00000000' + v.toString(16)).slice(-n); }; return h(dv.getUint32(o, true), 8) + '-' + h(dv.getUint16(o + 4, true), 4) + '-' + h(dv.getUint16(o + 6, true), 4) + '-' + h(dv.getUint8(o + 8), 2) + h(dv.getUint8(o + 9), 2) + '-' + [10, 11, 12, 13, 14, 15].map(function (i) { return h(dv.getUint8(o + i), 2); }).join(''); }
  function parseMinidump(buf) {
    var dv = new DataView(buf), b8 = new Uint8Array(buf);
    if (b8.length < 32 || String.fromCharCode(b8[0], b8[1], b8[2], b8[3]) !== 'MDMP') throw new Error('not a minidump');
    var ns = dv.getUint32(8, true), dir = dv.getUint32(12, true), D = { kind: 'dmp', size: b8.length, time: dv.getUint32(20, true) * 1000, streams: ns, mods: [], threadCount: 0 }, S = {}, i;
    for (i = 0; i < ns; i++) { var o = dir + i * 12; if (o + 12 > b8.length) break; S[dv.getUint32(o, true)] = { size: dv.getUint32(o + 4, true), rva: dv.getUint32(o + 8, true) }; }
    var td = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-16le') : null;
    function u16(rva) { var n = dv.getUint32(rva, true); return td ? td.decode(new Uint8Array(buf, rva + 4, n)) : ''; }
    if (S[7]) { var s7 = S[7].rva; D.arch = dv.getUint16(s7, true) === 9 ? 'x64' : dv.getUint16(s7, true) === 0 ? 'x86' : 'arch ' + dv.getUint16(s7, true); D.os = dv.getUint32(s7 + 8, true) + '.' + dv.getUint32(s7 + 12, true) + '.' + dv.getUint32(s7 + 16, true); }
    if (S[4]) { var m4 = S[4].rva, cnt = dv.getUint32(m4, true); for (i = 0; i < cnt; i++) { var mo = m4 + 4 + i * 108; if (mo + 108 > b8.length) break; var ms = dv.getUint32(mo + 24 + 8, true), ls = dv.getUint32(mo + 24 + 12, true); var cvSz = dv.getUint32(mo + 76, true), cvRva = dv.getUint32(mo + 80, true), cv = null; if (cvSz >= 24 && cvRva + 24 <= b8.length && String.fromCharCode(b8[cvRva], b8[cvRva + 1], b8[cvRva + 2], b8[cvRva + 3]) === 'RSDS') cv = { guid: fmtGuid(dv, cvRva + 4), age: dv.getUint32(cvRva + 20, true) };
      D.mods.push({ cv: cv, base: dv.getBigUint64(mo, true), size: dv.getUint32(mo + 8, true), stamp: dv.getUint32(mo + 16, true) * 1000, name: u16(dv.getUint32(mo + 20, true)).split('\\').pop(), ver: ms || ls ? (ms >>> 16) + '.' + (ms & 0xffff) + '.' + (ls >>> 16) + '.' + (ls & 0xffff) : '' }); } }
    if (S[3]) D.threadCount = dv.getUint32(S[3].rva, true);
    if (S[15]) { var m15 = S[15].rva, fl = dv.getUint32(m15 + 4, true); if (fl & 1) D.pid = dv.getUint32(m15 + 8, true); if (fl & 2) { D.created = dv.getUint32(m15 + 12, true) * 1000; D.userSec = dv.getUint32(m15 + 16, true); D.kernelSec = dv.getUint32(m15 + 20, true); } }
    if (S[6]) {
      var e = S[6].rva; D.exc = { tid: dv.getUint32(e, true), code: dv.getUint32(e + 8, true), flags: dv.getUint32(e + 12, true), addr: dv.getBigUint64(e + 24, true), params: [] };
      var np = Math.min(dv.getUint32(e + 32, true), 15); for (i = 0; i < np; i++) D.exc.params.push(dv.getBigUint64(e + 40 + i * 8, true));
      D.exc.name = EXC[D.exc.code] || ('0x' + D.exc.code.toString(16));
      if (D.exc.code === 0xc0000005 && D.exc.params.length > 1) { D.exc.access = D.exc.params[0] === 0n ? 'reading' : D.exc.params[0] === 1n ? 'writing' : D.exc.params[0] === 8n ? 'executing' : ''; D.exc.target = '0x' + D.exc.params[1].toString(16); }
      var ctxSize = dv.getUint32(e + 160, true), ctxRva = dv.getUint32(e + 164, true);
      if (ctxSize >= 0x100 && ctxRva + 0x100 <= b8.length) { D.exc.rip = dv.getBigUint64(ctxRva + 0xf8, true); D.exc.rsp = dv.getBigUint64(ctxRva + 0x98, true); }
      D.fault = resolveAddr(D, D.exc.addr);
    }
    return D;
  }
  function resolveAddr(D, a) { for (var i = 0; i < D.mods.length; i++) { var m = D.mods[i]; if (a >= m.base && a < m.base + BigInt(m.size)) return { mod: m.name, base: m.base.toString(16), off: (a - m.base).toString(16), owner: modOwner(m.name) }; } return null; }

  /* ---------- telling the uploaded files apart ---------- */
  function sniff(name, head, size) {
    var n = String(name || '').toLowerCase(), base = n.split(/[\\\/]/).pop();
    if (head && head.length >= 4 && head[0] === 0x4d && head[1] === 0x44 && head[2] === 0x4d && head[3] === 0x50) return 'dmp';
    if (/\.dmp$/.test(base)) return 'dmp';
    if (/\.pdb$/.test(base)) return 'pdb';
    if (/\.(runtime-xml|xml)$/.test(base)) return 'xml';
    if (/\.ini$/.test(base)) return 'ini';
    if (/\.(log|txt)$/.test(base)) return 'log';
    return '';
  }

  /* ---------- put the pieces together: one crash per CrashGUID, game logs on their own ---------- */
  function assemble(items) {
    /* a file the person set to "ignore" is left out; a log set to "game log" or "crash log" skips the guess */
    items = items.filter(function (it) { return it.forceRole !== 'ignore'; });
    var crashes = {}, games = [], loose = [], skipped = [], pdb = null;
    function gid(g) { return String(g || '').replace(/_\d+$/, ''); }
    function bucket(g) { g = gid(g); return crashes[g] || (crashes[g] = { guid: g, parts: {} }); }
    function put(it, b, key) { b[key] = it.data; b.parts[key] = it.name; it.role = 'crash'; it.crash = b.guid; }
    items.forEach(function (it) {
      it.role = ''; it.crash = '';
      var folder = (/(UECC-[A-Za-z0-9-]+?)(?:_\d+)?(?:[\\\/]|$)/.exec(it.path || '') || [])[1] || '';
      if (it.kind === 'pdb') { pdb = it.data; pdb.fileName = it.name; it.role = 'symbols'; return; }
      if (it.kind === 'xml') { var b = bucket(it.data.guid || folder || 'x' + hash8(it.name)); b.guid = it.data.guid || b.guid; b.folder = folder; put(it, b, 'xml'); }
      else if (it.kind === 'ini') { if (folder) put(it, bucket(folder), 'ini'); else loose.push(it); }
      else if (it.kind === 'dmp') { if (folder) put(it, bucket(folder), 'dmp'); else loose.push(it); }
      else if (it.kind === 'log') {
        var gl = it.data.guid || '';
        if (it.forceRole === 'game') { games.push(it); it.role = 'game'; }
        else if (it.forceRole === 'crash') put(it, bucket(folder || gl || 'x' + hash8(it.name)), 'log');
        else if (/UECC-/.test(folder) || (gl && crashes[gid(gl)] && crashes[gid(gl)].xml)) put(it, bucket(folder || gl), 'log');
        else loose.push(it);
      } else skipped.push(it.name);
    });
    /* files without a folder: the crash log carries the same CrashGUID as the xml; the minidump goes with the crash whose log ended nearest to its time */
    loose.forEach(function (it) {
      if (it.kind === 'log') {
        var c = crashes[gid(it.data.guid)];
        if (c && !c.log && it.data.exit && !it.data.exit.clean && it.data.durSec < 3600 && c.xml) put(it, c, 'log'); else { games.push(it); it.role = 'game'; }
      }
    });
    loose.forEach(function (it) {
      if (it.kind === 'dmp' || it.kind === 'ini') {
        var best = null, bd = 1e12;
        Object.keys(crashes).forEach(function (k) { var c = crashes[k]; if (c[it.kind]) return; var ref = c.log && c.log.end ? c.log.end : null; if (it.kind === 'ini') { if (!best) best = c; return; } if (ref != null) { var d = Math.abs(ref - it.data.time); if (d < bd) { bd = d; best = c; } } else if (!best) best = c; });
        if (best && (it.kind === 'ini' || bd < 120000 || bd === 1e12)) put(it, best, it.kind);
        else if (it.kind === 'dmp') put(it, bucket('dmp-' + hash8(it.name + it.data.size + it.data.time)), 'dmp');  /* a minidump on its own is a crash too */
        else skipped.push(it.name + ' (a settings file only: add the minidump or CrashContext.runtime-xml)');
      }
    });
    return { crashes: Object.keys(crashes).map(function (k) { return crashes[k]; }), games: games.map(function (g) { return { name: g.name, size: g.size, log: g.data }; }), pdb: pdb, items: items, skipped: skipped };
  }

  /* ---------- symbols: a Microsoft PDB (MSF 7.00) read through random-access slices, so a 500 MB file is never loaded whole ----------
     Only what a lookup needs is read: the stream directory, the build id, the section table and the public symbol address map. */
  function demangle(n) {
    n = String(n);
    if (n.charAt(0) !== '?') return n;
    var ctor = /^\?\?([01])/.exec(n), body = ctor ? n.slice(3) : n.slice(1);
    if (!ctor && (body.charAt(0) === '?' || body.charAt(0) === '$')) return n.length > 90 ? n.slice(0, 89) + '\u2026' : n;           /* ??_G, ??_R and other compiler helpers: keep as they are */
    var end = body.indexOf('@@'); if (end < 0) return n;
    var parts = body.slice(0, end).split('@'); if (parts.some(function (p) { return !p || p.charAt(0) === '?' || p.charAt(0) === '$'; })) return n.length > 90 ? n.slice(0, 89) + '…' : n;
    var scope = parts.slice().reverse();
    if (ctor) { var cls = scope[scope.length - 1]; return scope.join('::') + '::' + (ctor[1] === '1' ? '~' : '') + cls; }
    return scope.join('::');
  }
  function openPdb(rd) {
    var u8 = function (o, n) { return Promise.resolve(rd.read(o, n)).then(function (b) { return b instanceof Uint8Array ? b : new Uint8Array(b); }); };
    var bs, sizes = [], blocks = [], sym = null;
    function sread(i, off, len) {
      if (!blocks[i]) return Promise.reject(new Error('stream ' + i + ' is not in this PDB'));
      if (off + len > sizes[i]) len = Math.max(0, sizes[i] - off);
      var out = new Uint8Array(len), first = Math.floor(off / bs), last = Math.floor((off + len - 1) / bs), runs = [], k = first, run;
      while (len && k <= last) { run = 1; while (k + run <= last && blocks[i][k + run] === blocks[i][k + run - 1] + 1) run++; runs.push([k, run]); k += run; }
      return runs.reduce(function (p, r) {
        return p.then(function () {
          return u8(blocks[i][r[0]] * bs, r[1] * bs).then(function (chunk) {
            var a = Math.max(off, r[0] * bs), z = Math.min(off + len, (r[0] + r[1]) * bs);
            out.set(chunk.subarray(a - r[0] * bs, z - r[0] * bs), a - off);
          });
        });
      }, Promise.resolve()).then(function () { return out; });
    }
    var dvOf = function (b) { return new DataView(b.buffer, b.byteOffset, b.byteLength); };
    return u8(0, 64).then(function (sb) {
      if (String.fromCharCode.apply(null, sb.subarray(0, 25)) !== 'Microsoft C/C++ MSF 7.00\r') throw new Error('not a PDB (only the Microsoft MSF 7.00 format is read)');
      var d = dvOf(sb); bs = d.getUint32(32, true);
      var dirBytes = d.getUint32(44, true), mapAddr = d.getUint32(52, true), nd = Math.ceil(dirBytes / bs);
      return u8(mapAddr * bs, nd * 4).then(function (bm) {
        var bv = dvOf(bm), dir = new Uint8Array(nd * bs), ps = [], i;
        for (i = 0; i < nd; i++) (function (i) { ps.push(u8(bv.getUint32(i * 4, true) * bs, bs).then(function (c) { dir.set(c, i * bs); })); })(i);
        return Promise.all(ps).then(function () { return dir; });
      });
    }).then(function (dir) {
      var dd = dvOf(dir), ns = dd.getUint32(0, true), p = 4 + ns * 4, i, j;
      for (i = 0; i < ns; i++) sizes.push(dd.getUint32(4 + i * 4, true));
      for (i = 0; i < ns; i++) { var c = sizes[i] === 0xffffffff ? 0 : Math.ceil(sizes[i] / bs), a = []; if (sizes[i] === 0xffffffff) sizes[i] = 0; for (j = 0; j < c; j++) { a.push(dd.getUint32(p, true)); p += 4; } blocks.push(a); }
      return sread(1, 0, 28);
    }).then(function (info) {
      var iv = dvOf(info), P = { size: rd.size, guid: fmtGuid(iv, 12), age: iv.getUint32(8, true) };
      /* lookup tables are read the first time a name is wanted */
      P.lookup = function (rva) {
        var ready = sym ? Promise.resolve(sym) : sread(3, 0, 64).then(function (h) {
          var hv = dvOf(h), pubIx = hv.getUint16(16, true), recIx = hv.getUint16(20, true), optOff = 64 + hv.getUint32(24, true) + hv.getUint32(28, true) + hv.getUint32(32, true) + hv.getUint32(36, true) + hv.getUint32(40, true) + hv.getUint32(52, true), optSize = hv.getUint32(48, true);
          if (optSize < 12) throw new Error('this PDB has no section table');
          return sread(3, optOff, optSize).then(function (ob) {
            var shIx = dvOf(ob).getUint16(10, true);
            return Promise.all([sread(shIx, 0, sizes[shIx]), sread(pubIx, 0, 28)]).then(function (r) {
              var sh = dvOf(r[0]), secs = [], i; for (i = 0; i + 40 <= r[0].length; i += 40) secs.push({ vsize: sh.getUint32(i + 8, true), va: sh.getUint32(i + 12, true) });
              var pv = dvOf(r[1]), cbHash = pv.getUint32(0, true), cbAddr = pv.getUint32(4, true);
              return sread(pubIx, 28 + cbHash, cbAddr).then(function (am) { sym = { secs: secs, rec: recIx, addr: new DataView(am.buffer, am.byteOffset, am.byteLength), n: Math.floor(cbAddr / 4) }; return sym; });
            });
          });
        });
        return ready.then(function (S) {
          var si = -1, i; for (i = 0; i < S.secs.length; i++) if (rva >= S.secs[i].va && rva < S.secs[i].va + Math.max(S.secs[i].vsize, 1)) { si = i; break; }
          if (si < 0) return null;
          var seg = si + 1, off = rva - S.secs[si].va;
          function at(k) {
            var o = S.addr.getUint32(k * 4, true);
            return sread(S.rec, o, 4).then(function (h) {
              var len = dvOf(h).getUint16(0, true) + 2;
              return sread(S.rec, o, len).then(function (r) {
                var v = dvOf(r), type = v.getUint16(2, true); if (type !== 0x110e) return null;
                var e = 14; while (e < r.length && r[e] !== 0) e++;
                return { off: v.getUint32(8, true), seg: v.getUint16(12, true), name: String.fromCharCode.apply(null, r.subarray(14, e)) };
              });
            });
          }
          function search(lo, hi, best) {
            if (lo > hi) return Promise.resolve(best);
            var mid = (lo + hi) >> 1;
            return at(mid).then(function (r) { if (!r) return search(lo, mid - 1, best); var cmp = (r.seg - seg) || (r.off - off); return cmp <= 0 ? search(mid + 1, hi, r) : search(lo, mid - 1, best); });
          }
          return search(0, S.n - 1, null).then(function (r) { if (!r || r.seg !== seg || off - r.off > 0x100000) return null; return { raw: r.name, name: demangle(r.name), dist: off - r.off }; });
        });
      };
      return P;
    });
  }
  /* Put function names on the frames of the game's own module, but only when the PDB is the one the crashed exe was built with. */
  function symbolicate(parts, opts) {
    opts = opts || {}; var P = parts.pdb; if (!P) return Promise.resolve(parts);
    var work = Promise.resolve();
    (parts.crashes || []).forEach(function (c) {
      var exe = c.dmp && c.dmp.mods.filter(function (m) { return /^AeonVersus/i.test(m.name); })[0], cv = exe && exe.cv, name = P.fileName || 'the PDB';
      var frames = [];
      if (c.xml) { (c.xml.stack || []).concat(c.xml.callStack || []).forEach(function (f) { frames.push(f); }); (c.xml.threads || []).forEach(function (t) { if (t.crashed) t.frames.forEach(function (f) { frames.push(f); }); }); }
      if (!cv) { c.sym = { status: 'unverified', pdb: name, msg: name + ' is for build ' + P.guid + ', but there is no minidump with this crash, so there is no way to tell which build crashed. Names were not added. Add the minidump to check.' }; return; }
      var same = cv.guid.toLowerCase() === P.guid.toLowerCase() && cv.age === P.age;
      if (!same && !opts.force) { c.sym = { status: 'mismatch', pdb: name, pdbGuid: P.guid, exeGuid: cv.guid, msg: name + ' is for build ' + P.guid + ' (age ' + P.age + '), but the AeonVersus.exe that crashed is ' + cv.guid + ' (age ' + cv.age + ', built ' + new Date(exe.stamp).toISOString().replace('T', ' ').slice(0, 16) + ' UTC). Function names from the wrong PDB would be wrong, so none are shown. You need the PDB that was produced with that exact exe.' }; return; }
      var seen = {}, n = 0, todo = [];
      if (c.dmp && c.dmp.fault && /^AeonVersus/i.test(c.dmp.fault.mod)) todo.push(c.dmp.fault);
      frames.forEach(function (f) { if (/^AeonVersus/i.test(f.mod)) todo.push(f); });
      todo.forEach(function (f) {
        work = work.then(function () {
          var key = f.off; if (seen[key]) { f.sym = seen[key].name; f.raw = seen[key].raw; return; }
          return P.lookup(parseInt(f.off, 16)).then(function (r) { if (r) { seen[key] = r; f.sym = r.name; f.raw = r.raw; n++; } }, function () { });
        });
      });
      work = work.then(function () { c.sym = { status: same ? 'ok' : 'forced', pdb: name, pdbGuid: P.guid, exeGuid: cv.guid, msg: same ? name + ' is the PDB of the crashed AeonVersus.exe (build id ' + P.guid + ', age ' + P.age + '). Function names were added to the game frames.' : 'Names added from a PDB that does not match this build. Do not trust them.' }; });
    });
    return work.then(function () { return parts; });
  }

  /* ---------- is each file readable, and what does the reader still need ---------- */
  /* Per-file check. Notes are {s: pass|warn|fail|info, t}. The status of the file is the worst note. */
  function validateFile(it) {
    var d = it.data || {}, n = [], rank = { pass: 0, info: 0, warn: 1, fail: 2 }, st = 'pass';
    function add(s, t) { n.push({ s: s, t: t }); if (rank[s] > rank[st]) st = s; }
    if (it.kind === 'log') {
      if (!d.start) add('fail', 'No timestamped lines, so this is not an Unreal log (or it is empty).');
      else {
        if (!d.header || !d.header.openLocal) add('warn', 'The top of the file is missing (no "Log file open" line). The log was cut, so its clock zone is unknown and the startup facts are gone.');
        add('info', num0(d.total) + ' lines, ' + fmtDur(d.durSec) + (d.header && d.header.buildversion ? ', build ' + d.header.buildversion : '') + '.');
        if (it.role === 'crash') add(d.exit && d.exit.clean ? 'warn' : 'pass', d.exit && d.exit.clean ? 'A crash log should end where the game died, but this one shows a normal shutdown. Is it the game log?' : 'Ends where the game stopped, as a crash log should.');
        else { add(d.exit && d.exit.clean ? 'pass' : 'warn', d.exit && d.exit.clean ? 'Ends with a normal shutdown, so the whole run is in it.' : 'No normal shutdown line: the game was closed forcibly or crashed, so the end of the run is cut.'); if (d.durSec < 30) add('warn', 'Under 30 seconds long, too short to hold a match.'); }
        if (!d.phases || !d.phases.length) add(it.role === 'crash' ? 'info' : 'warn', it.role === 'crash' ? 'No map had loaded before the crash, so it happened during startup.' : 'No map loads were found, so there is no timeline to place against matches.');
        if (!d.counts.error && !d.counts.warning) add('info', 'No errors or warnings. Was the log taken at a low verbosity?');
        add('info', it.role === 'crash' ? 'Used as the crash log' + (it.crash ? ' of ' + String(it.crash).replace(/^UECC-Windows-/, '').slice(0, 8) : '') + '.' : 'Used as a game log.');
      }
    } else if (it.kind === 'xml') {
      if (!d.guid) add('fail', 'No CrashGUID: this is not a crash context.');
      if (!d.error) add('warn', 'No error message recorded.');
      if (!d.stack || !d.stack.length) add('warn', 'No call stack in the context, so the stack cannot be shown or compared with the dump.');
      else add('pass', d.stack.length + ' stack frames, ' + (d.threads ? d.threads.length : 0) + ' threads.');
      if (d.hash) add('info', 'Stack hash ' + d.hash.slice(0, 12) + '.'); else add('warn', 'No stack hash, so repeats of this crash cannot be grouped.');
      if (d.type && d.type !== 'Crash') add('info', 'Type: ' + d.type + '.');
    } else if (it.kind === 'dmp') {
      if (!d.exc) add('fail', 'No exception record: this dump was not taken at a crash, so there is no fault to read.');
      else add('pass', d.exc.name + (d.exc.access ? ' ' + d.exc.access + ' ' + d.exc.target : '') + (d.fault ? ' in ' + d.fault.mod + ' +0x' + d.fault.off : ' at an address in no loaded module') + '.');
      if (!d.mods || !d.mods.length) add('warn', 'No module list, so frames cannot be tied to a module or a build.');
      else { var exe = d.mods.filter(function (m) { return /^AeonVersus/i.test(m.name); })[0]; if (exe && exe.cv) add('info', 'Game exe build id ' + exe.cv.guid + ' (age ' + exe.cv.age + ').'); else if (exe) add('warn', 'The game exe has no build id recorded, so a PDB cannot be matched to it.'); else add('warn', 'AeonVersus.exe is not in the module list.'); }
      if (d.size < 200000) add('warn', 'Very small dump (' + Math.round(d.size / 1024) + ' KB). Part of the file may be missing.');
      add('info', (d.arch || '') + ', ' + d.threadCount + ' threads, ' + (d.mods ? d.mods.length : 0) + ' modules.');
    } else if (it.kind === 'ini') {
      add('pass', 'Crash reporter settings only. It adds no evidence on its own.');
    } else if (it.kind === 'pdb') {
      add('pass', 'Build id ' + d.guid + ', age ' + d.age + '.');
      add('info', 'It only gives names to the game frames, and only for the build it was made with.');
    }
    return { status: st, notes: n };
  }
  function num0(v) { return Number(v || 0).toLocaleString('en-US'); }
  /* What files the reader wants, what each one unlocks, and what can be read with the ones given. */
  function requirements(parts, ledgers, off) {
    var C = parts.crashes || [], G = parts.games || [], P = parts.pdb, n = C.length, rows = [], can = [];
    var cnt = function (k) { return C.filter(function (c) { return c.parts && c.parts[k]; }).length; };
    var names = function (k) { return C.filter(function (c) { return c.parts && c.parts[k]; }).map(function (c) { return c.parts[k]; }); };
    function crashRow(id, label, ext, gives, k, optional) {
      var have = cnt(k), state = n === 0 ? 'idle' : have === n ? 'ok' : have === 0 ? (optional ? 'optional' : 'missing') : 'partial';
      rows.push({ id: id, label: label, ext: ext, gives: gives, state: state, found: have ? have + ' of ' + n + ' crash' + (n === 1 ? '' : 'es') : '', note: state === 'missing' ? 'Add it to read the crash fully.' : state === 'partial' ? (n - have) + ' crash' + (n - have === 1 ? '' : 'es') + ' without it.' : '' });
    }
    rows.push({ id: 'game', label: 'Game log', ext: 'AeonVersus.log from the Logs folder', gives: 'Every error and warning grouped, the session timeline, and the comparison with the matches stored here.', state: G.length ? 'ok' : (n ? 'idle' : 'missing'), found: G.map(function (g) { return g.name; }).join(', '), note: G.length ? '' : n ? 'Only needed to review a play session.' : 'Add it to review a play session.' });
    rows.push({ id: 'ledgers', label: 'Stored matches', ext: 'Match Ledger files uploaded by an admin', gives: 'Proof that the log matches real play: start and end times, players, map, skill use.', state: !G.length ? 'idle' : off ? 'optional' : ledgers ? 'ok' : 'missing', found: ledgers ? ledgers + ' ledger' + (ledgers === 1 ? '' : 's') + ' stored' + (off ? ', not used' : '') : '', note: off ? 'Switched off in Options below.' : G.length && !ledgers ? 'Upload the ledgers from this session in Upload (admin).' : '' });
    crashRow('xml', 'Crash context', 'CrashContext.runtime-xml', 'The full call stack, launch options, hardware, build and the stack hash that groups repeats.', 'xml');
    crashRow('dmp', 'Minidump', 'UEMinidump.dmp', 'The exact fault, loaded modules with versions, and the build id that proves a PDB belongs to the crash.', 'dmp');
    crashRow('clog', 'Crash log', 'AeonVersus.log inside the crash folder', 'What the game was doing in its last seconds, and its crash id, which ties the files together.', 'log', true);
    crashRow('ini', 'Crash reporter ini', 'CrashReportClient.ini', 'Nothing beyond what the other files give.', 'ini', true);
    var sy = C.map(function (c) { return c.sym && c.sym.status; }).filter(Boolean), bad = sy.filter(function (s) { return s === 'mismatch' || s === 'forced'; }).length, unv = sy.filter(function (s) { return s === 'unverified'; }).length, ok = sy.filter(function (s) { return s === 'ok'; }).length;
    rows.push({ id: 'pdb', label: 'Symbols', ext: 'AeonVersus.pdb of the same build as the crashed exe', gives: 'Function names for the game frames of the call stack, in place of module and offset.', state: !P ? 'optional' : bad ? 'problem' : unv ? 'partial' : ok ? 'ok' : (n ? 'partial' : 'optional'), found: P ? (P.fileName || 'PDB') + ', build id ' + P.guid : '', note: !P ? 'Optional. Without it the stack shows module and offset only.' : bad ? 'It is from a different build than the crashed exe, so no names are shown.' : unv ? 'Cannot be checked: add the minidump of that crash.' : ok ? 'Matches the crashed build.' : n ? '' : 'Add a crash to use it.' });
    can.push({ t: 'Errors and warnings from a play session, grouped', ok: G.length > 0, needs: 'a game log' });
    can.push({ t: 'Check a play session against the stored matches', ok: G.length > 0 && ledgers > 0 && !off, needs: off ? 'the option "Compare the game log with the stored matches" switched on' : G.length ? 'stored match ledgers from that session' : 'a game log and stored match ledgers' });
    can.push({ t: 'The exact fault and loaded modules of a crash', ok: cnt('dmp') > 0, needs: 'a minidump (.dmp)' });
    can.push({ t: 'The full call stack, launch options and hardware of a crash', ok: cnt('xml') > 0, needs: 'the crash context (.runtime-xml)' });
    can.push({ t: 'Prove the crash files belong together', ok: n > 0 && C.some(function (c) { return c.xml && c.dmp; }), needs: 'the crash context and the minidump of the same crash' });
    can.push({ t: 'Function names for the game frames', ok: ok > 0, needs: !P ? 'the AeonVersus.pdb of the crashed build' : bad ? 'the PDB built with the crashed exe (the one added is from another build)' : 'a minidump to confirm the PDB matches' });
    return { rows: rows, can: can };
  }

  /* ---------- checks and cross-checks ---------- */
  function ck(list, id, group, status, title, detail, ev) { list.push({ id: id, group: group, status: status, title: title, detail: detail, ev: ev || '' }); }
  function wallOf(log, sec) { return log.wallStart + sec * 1000; }
  function clock(ms) { var d = new Date(ms); return ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2) + ':' + ('0' + d.getUTCSeconds()).slice(-2); }
  function day(ms) { var d = new Date(ms); return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2); }

  function crashSummary(c) {
    var x = c.xml, d = c.dmp, o = { guid: c.guid, parts: c.parts, hash: x ? x.hash : '', type: x ? (x.isEnsure ? 'Ensure' : x.isAssert ? 'Assertion' : x.isStall ? 'Stall' : x.type || 'Crash') : (d ? 'Crash' : ''), error: x ? x.error : (d ? d.exc.name + ' ' + (d.exc.access || '') + ' ' + (d.exc.target || '') : ''), diag: [] };
    o.exc = x ? x.exc : null; o.dump = d ? { time: d.time, size: d.size, os: d.os, arch: d.arch, threads: d.threadCount, mods: d.mods.length, exc: { code: d.exc && d.exc.code, name: d.exc && d.exc.name, access: d.exc && d.exc.access, target: d.exc && d.exc.target, addr: d.exc && ('0x' + d.exc.addr.toString(16)) }, fault: d.fault, uptime: d.created ? Math.max(0, Math.round((d.time - d.created) / 1000)) : null, cpuSec: d.userSec != null ? d.userSec + d.kernelSec : null,
      exe: (function () { var m = d.mods.filter(function (x) { return /^AeonVersus/i.test(x.name); })[0]; return m ? { name: m.name, guid: m.cv && m.cv.guid, age: m.cv && m.cv.age, stamp: m.stamp } : null; })(),
      other: d.mods.filter(function (m) { var ow = modOwner(m.name); return ow === 'mod' || ow === 'other'; }).map(function (m) { return { n: m.name, v: m.ver }; }).slice(0, 12) } : null;
    /* no crash context: the dump alone still gives the exception, the faulting frame and the loaded modules, but not the full call stack */
    if (!x && d && d.exc) { o.exc = { name: 'EXCEPTION_' + d.exc.name, access: d.exc.access || '', addr: d.exc.target || '' }; o.stack = d.fault ? [{ mod: d.fault.mod.replace(/\.(dll|exe)$/i, ''), base: d.fault.base, off: d.fault.off, owner: d.fault.owner }] : []; o.info = { pid: d.pid || 0, os: d.os || '' }; o.hash = 'dmp' + hash8(String(d.fault ? d.fault.mod + d.fault.off : '') + d.exc.code).toUpperCase(); o.dumpOnly = true; o.error = 'Unhandled Exception: EXCEPTION_' + d.exc.name + (d.exc.access ? ' ' + d.exc.access + ' address ' + d.exc.target : ''); }
    if (x) { o.info = { game: x.game, exe: x.exe, config: x.config, engine: x.engine, build: x.build, cmd: x.cmd, mode: x.mode, os: x.os, cpu: x.cpu, gpu: x.gpu, cores: x.cores, ramGB: x.ramGB, rhi: x.rhi, secs: x.secsSinceStart, pid: x.pid, baseDir: x.baseDir, oom: x.oom }; o.stack = x.stack.slice(0, 20); o.threads = x.threads.filter(function (t) { return t.crashed; }).map(function (t) { return { id: t.id, name: t.name, frames: t.frames }; }); o.threadCount = x.threads.length; }
    if (c.sym) o.sym = c.sym;
    if (c.log) { var L = c.log; o.log = { lines: L.lines, start: L.start, end: L.end, durSec: L.durSec, errors: L.counts.error, warnings: L.counts.warning, browse: L.browse, lastMap: L.phases.length ? L.phases[L.phases.length - 1].map : '', phases: L.phases.length, initSec: L.header.initSec || null, header: L.header, issues: L.issues.slice(0, 12) }; }
    return o;
  }

  function diagnoseCrash(o, checks) {
    var G = 'Crash ' + (o.guid || '').replace(/^UECC-Windows-/, '').slice(0, 8), info = o.info || {}, d = o.dump, x = o.exc, st = o.stack || [], i;
    var top = null; for (i = 0; i < st.length; i++) if (st[i].owner !== 'system') { top = st[i]; break; }
    var modInStack = st.filter(function (f) { return f.owner === 'mod'; }).length > 0 || (d && d.fault && d.fault.owner === 'mod');
    var cmd = info.cmd || '';
    /* 1. parts present */
    var miss = ['xml', 'dmp', 'log', 'ini'].filter(function (k) { return !o.parts[k]; });
    ck(checks, 'files:' + o.guid, G, miss.length ? (miss.indexOf('xml') >= 0 || miss.indexOf('dmp') >= 0 ? 'warn' : 'info') : 'pass', 'Crash files: ' + (4 - miss.length) + ' of 4', miss.length ? 'Missing: ' + miss.map(function (k) { return { xml: 'CrashContext.runtime-xml (call stack, hardware, launch command)', dmp: 'UEMinidump.dmp (exact fault address and loaded modules)', log: 'the game log from the crash (what the game was doing)', ini: 'CrashReportClient.ini' }[k]; }).join('; ') + '.' : 'Log, context, minidump and ini are all here, so the three sources can be checked against each other.');
    /* 2. crash guid agrees (log header vs xml) */
    if (o.log && o.guid) { var lg = String(o.logGuid || '').replace(/_\d+$/, ''), cg = o.guid.replace(/_\d+$/, ''); if (lg) ck(checks, 'guid:' + o.guid, G, lg === cg ? 'pass' : 'fail', 'Crash id in the log matches the crash context', lg === cg ? 'Both name ' + cg + '.' : 'The log says ' + lg + ' but the crash context says ' + cg + '. These files belong to different crashes.'); }
    /* 3. xml vs dmp exception */
    if (x && d && d.exc && !o.dumpOnly) {
      var codeOk = !x.name || (EXC[d.exc.code] || '').replace(/_/g, '') === x.name.replace(/^EXCEPTION_/, '').replace(/_/g, '') || x.name === 'EXCEPTION_' + (EXC[d.exc.code] || '');
      var tgtOk = !x.addr || !d.exc.target || BigInt(x.addr) === BigInt(d.exc.target);
      ck(checks, 'exc:' + o.guid, G, codeOk && tgtOk ? 'pass' : 'fail', 'Minidump exception agrees with the crash context', codeOk && tgtOk ? 'Both record ' + (x.name || d.exc.name) + (x.access ? ' ' + x.access + ' address ' + x.addr : '') + '.' : 'Context says ' + (o.error) + '; the dump says ' + d.exc.name + ' ' + (d.exc.access || '') + ' ' + (d.exc.target || '') + '.');
    }
    /* 4. the top stack frame resolves in the dump's module list at the same address */
    if (x && d && d.exc && d.fault && st.length && !o.dumpOnly) {
      var f0 = st[0], same = f0.mod.toLowerCase().replace(/\.(dll|exe)$/, '') === d.fault.mod.toLowerCase().replace(/\.(dll|exe)$/, '') && parseInt(f0.off, 16) === parseInt(d.fault.off, 16);
      ck(checks, 'stack:' + o.guid, G, same ? 'pass' : 'warn', 'Call stack top frame lands where the dump says it crashed', same ? f0.mod + ' + 0x' + f0.off + ' in both, with the module loaded at the same address.' : 'Context top frame is ' + f0.mod + ' + 0x' + f0.off + ' but the dump faulted in ' + d.fault.mod + ' + 0x' + d.fault.off + '.');
    }
    /* symbols: does the PDB belong to the crashed build? */
    if (o.sym) ck(checks, 'pdb:' + o.guid, G, o.sym.status === 'ok' ? 'pass' : o.sym.status === 'unverified' ? 'warn' : 'fail', o.sym.status === 'ok' ? 'Symbols match the crashed build' : o.sym.status === 'unverified' ? 'Symbols cannot be checked against the crashed build' : 'Symbols are from a different build', o.sym.msg);
    /* 5. time of the dump against the end of the crash log */
    if (d && o.log && o.log.end) { var dt = (d.time - o.log.end) / 1000; ck(checks, 'time:' + o.guid, G, Math.abs(dt) <= 10 ? 'pass' : Math.abs(dt) <= 120 ? 'warn' : 'fail', 'Dump time against the last log line', 'The dump was written ' + r1(Math.abs(dt)) + ' s ' + (dt >= 0 ? 'after' : 'before') + ' the last line of the crash log' + (Math.abs(dt) <= 10 ? ', so they are the same moment.' : Math.abs(dt) <= 120 ? '.' : '. They are probably from different runs.')); }
    /* 6. versions */
    if (o.log && o.log.header && info.build && o.log.header.buildversion) { var vOk = info.build === o.log.header.buildversion; ck(checks, 'build:' + o.guid, G, vOk ? 'pass' : 'fail', 'Build version agrees between crash context and log', vOk ? 'Both say ' + info.build + '.' : 'Context: ' + info.build + ', log: ' + o.log.header.buildversion + '.'); }
    /* 7. process life: dump process times vs log */
    if (d && d.uptime != null && o.log && o.log.durSec != null) { var gap = Math.abs(d.uptime - o.log.durSec); ck(checks, 'uptime:' + o.guid, G, gap <= 15 ? 'pass' : gap <= 60 ? 'warn' : 'fail', 'Process lifetime agrees with the log', 'The dump says the process ran ' + fmtDur(d.uptime) + ' before it crashed; the log covers ' + fmtDur(o.log.durSec) + '.'); }
    /* 8. when in the run */
    if (o.log) { var inMatch = o.log.phases && o.log.lastMap && !/lobby|menu/i.test(o.log.lastMap); var early = o.log.durSec < 60 || (info.secs === 0 && o.log.phases <= 1);
      ck(checks, 'phase:' + o.guid, G, 'info', early ? 'Crashed during startup' : inMatch ? 'Crashed in a match map' : 'Crashed after startup', early ? 'The log ends ' + fmtDur(o.log.durSec) + ' in' + (o.log.lastMap ? ', while loading ' + o.log.lastMap : '') + '. It never reached a match, so no match data is affected.' : 'Last map before the crash: ' + (o.log.lastMap || 'unknown') + '.'); }
    /* 9. things that look wrong in the launch */
    if (o.log && o.log.browse && o.log.browse.some(function (b) { return /\.(dll|exe)\b|\\/i.test(b); })) { var bad = o.log.browse.filter(function (b) { return /\.(dll|exe)\b|\\/i.test(b); })[0]; ck(checks, 'browse:' + o.guid, G, 'fail', 'Launch argument was read as a map address', 'The game tried to open "' + bad + '" as its first map. A launch option (' + (cmd.trim() || 'see command line') + ') was passed in a form the game does not understand and ended up in the map path.'); }
    if (/--ue4ss|ue4ss/i.test(cmd) || modInStack) ck(checks, 'mod:' + o.guid, G, 'warn', 'A mod loader (UE4SS) is in the process', 'UE4SS.dll is loaded' + (modInStack ? ' and appears in the crash stack' : '') + (/ue4ss/i.test(cmd) ? ', and the launch command passes --ue4ss-path' : '') + '. A crash that goes through an injected mod loader is not evidence of a game bug until it also happens without it.');
    if (info.oom) ck(checks, 'oom:' + o.guid, G, 'fail', 'Out of memory', 'The crash context flags an out-of-memory failure.');
    return { top: top, modInStack: modInStack };
  }

  /* what a crash means, in plain words, for the finding card */
  function crashFinding(o, n, dx) {
    var d = o.dump, x = o.exc, why = [], fix = [], err = o.error || 'Crash';
    if (x && /ACCESS_VIOLATION/.test(x.name) && /^0xf+$/i.test(x.addr)) why.push('The code read address ' + x.addr + ', which is -1. A pointer was set to the "invalid" marker value and then used.');
    else if (x && /ACCESS_VIOLATION/.test(x.name)) why.push('The code touched memory it does not own (' + (x.access || 'access') + ' ' + x.addr + ').');
    if (dx.modInStack) why.push('The stack passes through the UE4SS mod loader, which hooks game functions. Test the same steps with it off (no --ue4ss-path) before treating this as a game bug.');
    if (d && d.fault) why.push('Fault is inside ' + d.fault.mod + ' (+0x' + d.fault.off + ')' + (d.fault.owner === 'system' ? ', a Windows runtime library, so the bad pointer came from the code that called it, further down the stack.' : '.'));
    var top = dx.top; if (top) fix.push('First non-system frame: ' + top.mod + ' + 0x' + top.off + (top.sym ? ' = ' + top.sym : '') + (top.owner === 'game' ? (top.sym ? ' (game code)' : ' (game code: add the AeonVersus.pdb of this exact build to see the function name)') : top.owner === 'mod' ? ' (mod code)' : '') + '.');
    return { key: 'cr:' + (o.hash || o.guid || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16), id: 'crash', sev: 'critical', area: 'crash', title: 'Crash: ' + clip(err.replace(/^Unhandled Exception: /, ''), 90), n: n, why: why.join(' '), fix: fix.join(' ') || 'Resolve the stack with the build symbols.', det: [], samples: [clip(err, 200)], ph: {}, first: 0, last: 0, crashHash: o.hash };
  }

  /* ---------- the match side: the game log against stored ledgers ---------- */
  function overlap(a0, a1, b0, b1) { return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)); }
  /* skill names a problem mentions, from tags (Aeon.Ability.MultiJump.Depleted) and ability classes (GA_CrushingBlows_C) */
  function tokensOf(issue) {
    var T = {}, src = (issue.det || []).slice(0, 1).map(function (d) { return d.k; }).concat(issue.samples || []);
    src.forEach(function (s) { var m, re = /(?:Aeon\.Ability\.|GA_)([A-Za-z0-9]+)/g; while ((m = re.exec(s))) T[m[1]] = 1; });
    return Object.keys(T).filter(function (t) { return t.length >= 4 && !/^(Fail|Active|Status|Cooldown)$/.test(t); });
  }
  function castCount(match, tok) { var c = 0, k = alnum(tok), who = 0; Object.keys(match.casts || {}).forEach(function (n) { var a = alnum(n); if (a && (a.indexOf(k) >= 0 || k.indexOf(a) >= 0)) c += match.casts[n]; }); return c; }

  function crossMatches(logs, matches, checks, issues) {
    var links = [], gl = logs[0]; if (!gl) return links;
    var L = gl.log, GR = 'Game log and match data';
    var mp = L.phases.filter(function (p) { return p.kind === 'match'; });
    if (!matches || !matches.length) { ck(checks, 'm:none', GR, 'info', 'No stored matches to compare with', 'Upload the Match Ledger files from this play session to check the log against real match data.'); return annotate(L, links, [], issues); }
    /* Both sides are put on UTC. A ledger carries its end time in UTC (meta.endedAtUtc) and its length, so its window is exact. A ledger with only a local
       start time (the file name) is moved to UTC with the clock zone the log itself reports. */
    function win(m) { var d = (m.dur || 0) * 1000; if (m.endUtc != null) return { s: m.endUtc - d, e: m.endUtc, src: 'utc' }; if (m.startWall != null) { var s = m.startWall - L.tzMin * 60000; return { s: s, e: s + d, src: 'wall' }; } return null; }
    var utc = function (sec) { return L.start + sec * 1000; }, lc = function (ms) { return clock(ms + L.tzMin * 60000); };
    var winStart = utc(0), winEnd = utc(L.durSec);
    var near = matches.filter(function (m) { var w = win(m); return w && overlap(w.s, w.e, winStart, winEnd) > 0; });
    if (!mp.length) ck(checks, 'm:phases', GR, 'info', 'This log has no match map', 'The log never left the lobby, so there is nothing to compare with match data.');
    ck(checks, 'm:window', GR, near.length ? 'pass' : 'warn', 'Stored matches inside the log time span', near.length ? near.length + ' stored match' + (near.length === 1 ? '' : 'es') + ' fall between ' + day(winStart + L.tzMin * 60000) + ' ' + lc(winStart) + ' and ' + lc(winEnd) + ' (' + near.map(function (m) { return m.title; }).join(', ') + ').' : 'No stored match falls between ' + day(winStart + L.tzMin * 60000) + ' ' + lc(winStart) + ' and ' + lc(winEnd) + '. Upload the ledgers from that session, or the log is from another day.');
    var used = {}, zone = null;
    mp.forEach(function (p, idx) {
      var ps = utc(p.t0), pe = utc(p.t1), best = null, bo = 0, bw = null;
      near.forEach(function (m) { var w = win(m), ov = overlap(ps, pe, w.s, w.e); if (ov > bo && !used[m.id]) { bo = ov; best = m; bw = w; } });
      var lab = 'Match ' + (idx + 1) + ' in the log (' + lc(ps) + ')';
      if (!best || bo < 60000) { ck(checks, 'm:p' + idx, GR, 'warn', lab + ': no stored match', 'The log shows a match on ' + p.map + ' from ' + lc(ps) + ' to ' + lc(pe) + ' (' + fmtDur(p.t1 - p.t0) + '). No stored ledger overlaps it, so the stats are missing this match or its ledger was never uploaded.'); links.push({ phase: p.i, idx: idx + 1, match: null }); return; }
      used[best.id] = 1;
      var lk = { phase: p.i, idx: idx + 1, match: best.id, title: best.title, dur: best.dur };
      links.push(lk);
      var startGap = (bw.s - ps) / 1000, endGap = (pe - bw.e) / 1000;
      ck(checks, 'm:s' + idx, GR, Math.abs(startGap) <= 150 ? 'pass' : Math.abs(startGap) <= 600 ? 'warn' : 'fail', lab + ' starts with the ledger', 'Ledger "' + best.title + '" starts ' + r1(Math.abs(startGap)) + ' s ' + (startGap >= 0 ? 'after' : 'before') + ' the map load. ' + (Math.abs(startGap) <= 150 ? 'Normal: the ledger starts when the countdown ends.' : 'That is a long gap, so check that this is the right ledger.'));
      ck(checks, 'm:l' + idx, GR, endGap >= -20 && endGap <= 120 ? 'pass' : endGap < -20 ? 'warn' : 'info', lab + ' ends with the ledger', 'The log\'s map phase ends ' + r1(Math.abs(endGap)) + ' s ' + (endGap >= 0 ? 'after' : 'before') + ' the ledger\'s end (' + fmtDur(best.dur || 0) + ' recorded, ' + fmtDur(p.t1 - p.t0) + ' in the log). ' + (endGap < -20 ? 'The client left before the ledger ended: the player dropped out, or the ledger kept running after they left.' : endGap > 120 ? 'The client stayed on the map after the match ended (results screen).' : 'The match ended and the host closed the session.'));
      if (best.map && p.map) { var okMap = alnum(best.map) === alnum(p.map) || alnum(best.map).indexOf(alnum(p.map)) >= 0 || alnum(p.map).indexOf(alnum(best.map)) >= 0; ck(checks, 'm:m' + idx, GR, okMap ? 'pass' : 'warn', lab + ': map name', 'Log map ' + p.map + ', ledger map ' + best.map + '.'); }
      var names = {}; L.players.forEach(function (q) { if (q.ph[p.i] || q.ph[p.i - 1] || q.ph[p.i - 2]) names[q.name] = 1; });
      var ln = Object.keys(names), hum = best.humans || [];
      if (ln.length && hum.length) { var inL = hum.filter(function (h) { return names[h]; }).length, onlyL = ln.filter(function (q) { return hum.indexOf(q) < 0; }); ck(checks, 'm:n' + idx, GR, inL === hum.length ? 'pass' : inL ? 'warn' : 'fail', lab + ': players', inL + ' of ' + hum.length + ' ledger players are named in the log' + (inL < hum.length ? ' (not named: ' + hum.filter(function (h) { return !names[h]; }).slice(0, 4).join(', ') + ')' : '') + (onlyL.length ? '; named in the log only: ' + onlyL.slice(0, 4).join(', ') : '') + '. The log only names players the lobby announced, so a late joiner can be missing.'); }
      lk.startGap = r1(startGap); lk.endGap = r1(endGap); lk.errors = p.errors; lk.warnings = p.warnings; lk.endReason = best.endReason || ''; lk.map = best.map || p.map; lk.relics = best.relicEvents || 0;
      /* the two files stamp the same match with local clocks: do they use the same zone? */
      if (bw.src === 'utc' && best.startWall != null && !zone) { var diff = Math.round(((best.startWall - (bw.s + L.tzMin * 60000)) / 60000) / 15) * 15; zone = { diff: diff, title: best.title }; }
    });
    if (zone) ck(checks, 'm:zone', GR, Math.abs(zone.diff) >= 30 ? 'warn' : 'pass', 'Local clocks agree between the log and the ledgers', Math.abs(zone.diff) >= 30 ? 'The ledger "' + zone.title + '" stamps its start ' + fmtDur(Math.abs(zone.diff) * 60) + ' ' + (zone.diff < 0 ? 'earlier' : 'later') + ' than the game log\'s own local clock for the same moment. They use different clock zones (or one ignores daylight saving). Matching used the ledger\'s UTC end time, so the links above are right, but any local time shown from the ledger name is off by that much.' : 'The ledger and the log agree on the local time of the same match.');
    var linked = links.filter(function (l) { return l.match; }).length;
    ck(checks, 'm:count', GR, mp.length && linked === mp.length ? 'pass' : mp.length ? 'warn' : 'info', 'Matches in the log against stored ledgers', mp.length ? 'The log shows ' + mp.length + ' match' + (mp.length === 1 ? '' : 'es') + '; ' + linked + ' ' + (linked === 1 ? 'has' : 'have') + ' a stored ledger' + (linked < mp.length ? ', ' + (mp.length - linked) + ' ' + (mp.length - linked === 1 ? 'is' : 'are') + ' missing from the stats.' : '.') : 'No match played.');
    return annotate(L, links, matches, issues);
  }
  /* each problem against the map phases it happened in and, when there are ledgers, against the data of those matches */
  function annotate(L, links, matches, issues) {
    issues.forEach(function (is) {
      var ev = [], phs = Object.keys(is.ph || {}).map(Number), inMatch = 0, inLobby = 0;
      phs.forEach(function (k) { var p = L.phases[k]; if (!p) return; if (p.kind === 'match') inMatch += is.ph[k]; else inLobby += is.ph[k]; });
      is.inMatch = inMatch; is.inLobby = inLobby;
      var toks = tokensOf(is), lm = links.filter(function (l) { return l.match && is.ph && is.ph[l.phase]; });
      if (toks.length && lm.length && is.sev !== 'info' && is.sev !== 'low') toks.slice(0, 2).forEach(function (t) {
        var tot = 0; lm.forEach(function (l) { var m = matches.filter(function (x) { return x.id === l.match; })[0]; if (m) tot += castCount(m, t); });
        if (tot) ev.push('Ledger shows ' + t + ' cast ' + tot + (tot === 1 ? ' time' : ' times') + ' in the ' + lm.length + ' linked match' + (lm.length === 1 ? '' : 'es') + ', so players do use it and this can be reproduced in play.'); else ev.push('Ledger shows no casts of ' + t + ' in the linked match' + (lm.length === 1 ? '' : 'es') + ' (the ledger may not record this ability, or it is a passive or an item).');
      });
      if (is.id === 'relic-rpc' && lm.length) { var rel = 0; lm.forEach(function (l) { rel += l.relics || 0; }); ev.push(rel ? 'The ledger recorded ' + rel + ' relic event' + (rel === 1 ? '' : 's') + ' in these matches, so relics did spawn on the host. This is noise on a client.' : 'The ledger recorded no relic events in the linked matches. Relics may not be spawning at all.'); if (!rel && lm.length) is.sev = 'high'; }
      if (is.id === 'net-failure') {
        var atEnd = phs.length > 0 && phs.every(function (k) { var nx = L.phases[k + 1]; return L.phases[k] && L.phases[k].kind === 'match' && nx && nx.afterClose; });
        if (atEnd) { is.sev = 'info'; ev.push('Every failure is in a match map and the next thing in the log is the host closing the session. That is how a match ends for a client, not a dropped connection.'); }
        else ev.push('At least one failure is not followed by the host closing the session at the end of a match, so a player may have dropped mid-match. Check that match\'s ledger for the player leaving.');
      }
      if (inMatch + inLobby > 0) ev.push(inMatch + ' of ' + (inMatch + inLobby) + ' happened during a match, ' + inLobby + ' in lobby or menus.');
      is.ev = ev;
    });
    return links;
  }

  /* ---------- the whole analysis ---------- */
  function analyze(parts, matches, opts) {
    opts = opts || {};
    var checks = [], findings = [], crashes = (parts.crashes || []).map(function (c) { var s = crashSummary(c); s.logGuid = c.log && c.log.guid; return s; }), games = parts.games || [], i;
    var issues = [], sources = [], seenIssue = {};
    if (parts.pdb) sources.push({ kind: 'pdb', name: parts.pdb.fileName || 'symbols', size: parts.pdb.size || 0, lines: 0, parts: ['pdb'] });
    /* game logs */
    games.forEach(function (g) { var L = g.log; sources.push({ kind: 'game', name: g.name, size: g.size, lines: L.lines, parts: ['log'] }); });
    var G0 = games[0] && games[0].log;
    if (games.length > 1) ck(checks, 'log:many', 'Game log', 'warn', games.length + ' game logs uploaded, only the first is analysed', 'Only "' + games[0].name + '" is read. The other ' + (games.length - 1) + ' (' + clip(games.slice(1).map(function (g) { return g.name; }).join(', '), 160) + ') are not in these findings. Check one play session at a time.');
    if (G0) {
      var L = G0, G = 'Game log';
      L.issues.forEach(function (is) { if (is.n && !seenIssue[is.key]) { seenIssue[is.key] = 1; issues.push(is); } });
      ck(checks, 'log:exit', G, L.exit.clean ? 'pass' : (crashes.length && L.durSec ? 'info' : 'warn'), L.exit.clean ? 'Log ends with a normal shutdown' : 'Log ends without a normal shutdown', L.exit.clean ? 'The last lines are the engine shutting down (LogExit: Exiting).' : 'There is no "LogExit: Exiting." line. The game was killed or crashed before it could close the log.');
      var top = L.issues[0], spam = L.issues.filter(function (x) { return x.n >= 1000; }), errPct = L.total ? 100 * (L.counts.error + L.counts.warning) / L.total : 0;
      ck(checks, 'log:spam', G, spam.length ? 'warn' : 'pass', 'Log noise', spam.length ? spam.length + ' problem' + (spam.length === 1 ? '' : 's') + ' repeat 1,000 times or more (' + clip(spam.map(function (s) { return s.title + ' x' + s.n; }).join('; '), 240) + '). ' + r1(errPct) + '% of all log lines are errors or warnings, which hides new ones.' : r1(errPct) + '% of log lines are errors or warnings.');
      ck(checks, 'log:errors', G, L.counts.error ? 'warn' : 'pass', 'Errors in the log', L.counts.error + ' error line' + (L.counts.error === 1 ? '' : 's') + ' and ' + L.counts.warning + ' warnings across ' + L.issues.length + ' distinct problems.');
      if (L.header.initSec) ck(checks, 'log:init', G, L.header.initSec > 30 ? 'warn' : 'pass', 'Startup time', 'The engine took ' + L.header.initSec + ' s to start.');
      var slow = L.phases.filter(function (p) { return (p.loadSec || 0) > 20 || (p.travelSec || 0) > 20; }); if (L.phases.length) ck(checks, 'log:loads', G, slow.length ? 'warn' : 'pass', 'Map loads', slow.length ? slow.length + ' map load' + (slow.length === 1 ? '' : 's') + ' took longer than 20 s.' : L.phases.length + ' map change' + (L.phases.length === 1 ? '' : 's') + ', none slow.');
      if (L.metrics.pso > 100) ck(checks, 'log:pso', G, L.metrics.pso > 500 ? 'warn' : 'info', 'Shader (PSO) hitches', L.metrics.pso + ' pipeline-state creation hitches were counted. Each one is a visible stutter the first time an effect shows.');
      if (L.browse.some(function (b) { return /\.(dll|exe)\b|\\/i.test(b); })) ck(checks, 'log:browse', G, 'fail', 'Launch argument was read as a map address', 'The first map the game opened was "' + L.browse.filter(function (b) { return /\.(dll|exe)\b|\\/i.test(b); })[0] + '". A launch option was passed in a way the game reads as a map.');
      var players = L.players.length; if (players) ck(checks, 'log:players', G, 'info', 'Players seen in the log', players + ' name' + (players === 1 ? '' : 's') + ': ' + clip(L.players.map(function (p) { return p.name; }).join(', '), 200) + '.');
    }
    /* crashes */
    var byHash = {}; crashes.forEach(function (c) { var k = c.hash || c.guid; (byHash[k] = byHash[k] || []).push(c); });
    var crashFind = [];
    Object.keys(byHash).forEach(function (k) {
      var grp = byHash[k], first = grp[0], dx = null;
      grp.forEach(function (c) { var d = diagnoseCrash(c, checks); if (!dx) dx = d; sources.push({ kind: 'crash', name: c.guid, size: (c.dump && c.dump.size) || 0, lines: c.log ? c.log.lines : 0, parts: Object.keys(c.parts) }); });
      var f = crashFind.length; var cf = crashFinding(first, grp.length, dx || {}); cf.occ = grp.map(function (c) { return { guid: c.guid, at: c.dump && c.dump.time || (c.log && c.log.end) || 0 }; }); crashFind.push(cf);
      if (grp.length > 1) { var ds = grp.map(function (c) { return c.dump && c.dump.time || 0; }).sort(); ck(checks, 'repeat:' + k.slice(0, 8), 'Crash ' + (first.guid || '').replace(/^UECC-Windows-/, '').slice(0, 8), 'fail', 'Same crash ' + grp.length + ' times', 'Every stack hash is ' + (first.hash || '').slice(0, 12) + '. They happened ' + (ds[0] && ds[ds.length - 1] ? fmtDur((ds[ds.length - 1] - ds[0]) / 1000) + ' apart' : 'in a row') + ' with the same steps, so it reproduces every time and is not a random fault.'); }
    });
    /* the game log against stored matches */
    var links = G0 ? crossMatches(games, matches || [], checks, issues) : [];
    /* a game log and a crash: is the crash inside that log's run? */
    if (G0 && crashes.length) {
      var inRun = crashes.filter(function (c) { var t = (c.dump && c.dump.time) || (c.log && c.log.end); return t && t >= G0.start - 1000 && t <= G0.end + 1000; }).length;
      ck(checks, 'run', 'Game log and crash', inRun ? 'warn' : 'info', 'Crashes against the game log run', inRun ? inRun + ' of ' + crashes.length + ' crash' + (crashes.length === 1 ? '' : 'es') + ' happened during the uploaded game log\'s run, so the log shows what the game was doing just before.' : 'None of the ' + crashes.length + ' crash' + (crashes.length === 1 ? '' : 'es') + ' belongs to the uploaded game log. They are from other runs (' + day(crashes[0].dump && crashes[0].dump.time || (crashes[0].log && crashes[0].log.end) || 0) + ' against the game log on ' + day(G0.start) + '), so they are reported on their own.');
    }
    findings = crashFind.concat(issues);
    findings.forEach(function (f) { if (f.sev == null) f.sev = 'medium'; });
    findings.sort(function (a, b) { return SEV.indexOf(a.sev) - SEV.indexOf(b.sev) || (b.score || 0) - (a.score || 0) || b.n - a.n; });
    /* the same finding on several crashes of one group is shown once */
    var seenCk = {}, merged = []; checks.forEach(function (c) { var k = c.status + '|' + c.title + '|' + c.detail; if (seenCk[k]) { seenCk[k].group = 'Crashes (' + (++seenCk[k].times) + ' of them)'; return; } c.times = 1; seenCk[k] = c; merged.push(c); }); checks = merged;
    var cnt = { fail: 0, warn: 0, pass: 0, info: 0 }; checks.forEach(function (c) { cnt[c.status]++; });
    var sevN = {}; SEV.forEach(function (s) { sevN[s] = findings.filter(function (f) { return f.sev === s; }).length; });
    var info0 = (crashes[0] && crashes[0].info) || {};
    /* a few plain sentences that sum the report up */
    var head = [];
    crashFind.forEach(function (cf) {
      var c0 = byHash[cf.crashHash || (cf.occ[0] && cf.occ[0].guid)] || [], f0 = c0[0] || {}, st0 = (f0.stack || []).filter(function (f) { return f.owner !== 'system'; })[0], dm = f0.dump && f0.dump.fault, mod = (f0.stack || []).some(function (f) { return f.owner === 'mod'; });
      head.push(cf.n + ' crash' + (cf.n === 1 ? '' : 'es') + ' with the same stack: ' + String(f0.error || 'crash').replace(/^Unhandled Exception: /, '') + (dm ? ' in ' + dm.mod : '') + (st0 && st0.owner === 'mod' ? ', called from ' + st0.mod : '') + '.' + (mod ? ' A mod loader is in the stack, so confirm without it before calling it a game bug.' : ''));
    });
    if (G0) {
      var nm = G0.phases.filter(function (p) { return p.kind === 'match'; }).length, lk = links.filter(function (l) { return l.match; }).length;
      if (nm) head.push('Game log: ' + nm + ' match' + (nm === 1 ? '' : 'es') + ' played over ' + fmtDur(G0.durSec) + '; ' + (matches && matches.length ? lk + ' matched to stored ledgers' + (lk < nm ? ', ' + (nm - lk) + ' missing from the stats' : '') : 'no stored ledgers to compare with') + '.');
      var hi = findings.filter(function (f) { return f.sev === 'high' || (f.sev === 'critical' && f.area !== 'crash'); }); if (hi.length) head.push(hi.length + ' high-severity problem' + (hi.length === 1 ? '' : 's') + ': ' + hi.slice(0, 3).map(function (f) { return f.title + (f.det && f.det[0] ? ' (' + f.det[0].k + ')' : ''); }).join('; ') + '.');
    }
    var summary = { headlines: head, status: cnt.fail || sevN.critical ? 'fail' : cnt.warn || sevN.high ? 'warn' : 'pass', crashes: crashes.length, crashGroups: crashFind.length, findings: findings.length, sev: sevN, checks: cnt, errors: G0 ? G0.counts.error : 0, warnings: G0 ? G0.counts.warning : 0, lines: G0 ? G0.total : 0, start: G0 ? G0.start : (crashes[0] && crashes[0].dump && crashes[0].dump.time) || 0, end: G0 ? G0.end : 0, durSec: G0 ? G0.durSec : 0, tz: G0 ? G0.tzMin : 0, build: (G0 && G0.header.buildversion) || info0.build || '', engine: (G0 && G0.header.engineversion) || info0.engine || '', os: (G0 && G0.header.os) || info0.os || '', cpu: (G0 && G0.header.cpu) || info0.cpu || '', gpu: (G0 && G0.header.gpu) || info0.gpu || '', matchesLinked: links.filter(function (l) { return l.match; }).length, matchPhases: links.length };
    var files = (parts.items || []).map(function (it) { var v = validateFile(it); return { key: it.key || '', name: it.name, kind: it.kind, size: it.size || 0, role: it.role || '', auto: !it.forceRole, forced: it.forceRole || '', status: v.status, notes: v.notes }; });
    return { v: 1, createdAt: Date.now(), summary: summary, files: files, req: requirements(parts, opts.ledgerCount != null ? opts.ledgerCount : (matches || []).length, !!opts.ledgersOff), sources: sources, findings: findings.slice(0, 300), checks: checks, crashes: crashes.map(function (c) { delete c.logGuid; return c; }), links: links,
      game: G0 ? { header: G0.header, counts: G0.counts, phases: G0.phases, players: G0.players.map(function (p) { return { name: p.name, team: p.team }; }), exit: G0.exit, metrics: G0.metrics, nets: G0.nets.slice(0, 60), durSec: G0.durSec, start: G0.start, tzMin: G0.tzMin, lines: G0.total, topCats: topOf(G0.cats, 8) } : null };
  }

  /* ---------- plain text for the devs ---------- */
  function toText(rep, only) {
    var s = rep.summary, L = [];
    L.push('ArcturaStats bug report');
    L.push('Build ' + (s.build || '?') + (s.engine ? ' | engine ' + s.engine : '') + (s.os ? ' | ' + s.os : '') + (s.gpu ? ' | ' + s.gpu : ''));
    if (s.start) L.push('Log run: ' + new Date(s.start).toISOString().replace('T', ' ').slice(0, 19) + ' UTC, ' + fmtDur(s.durSec) + ', ' + (s.lines || 0) + ' lines');
    L.push(s.crashes + ' crash' + (s.crashes === 1 ? '' : 'es') + ', ' + s.findings + ' findings (' + SEV.map(function (k) { return s.sev[k] + ' ' + k; }).join(', ') + ')');
    L.push('');
    (rep.findings || []).filter(function (f) { return !only || only(f); }).forEach(function (f) {
      L.push('- [' + f.sev + '] ' + f.title + (f.n > 1 ? ' (x' + f.n + ')' : '') + ' | ' + f.area);
      if (f.det && f.det.length) L.push('  On: ' + f.det.slice(0, 4).map(function (d) { return d.k + (d.n > 1 ? ' x' + d.n : ''); }).join('; '));
      if (f.why) L.push('  Why it matters: ' + f.why);
      (f.ev || []).forEach(function (e) { L.push('  Match data: ' + e); });
      if (f.fix) L.push('  Fix: ' + f.fix);
      if (f.samples && f.samples[0]) L.push('  Log: ' + f.samples[0]);
    });
    var bad = (rep.checks || []).filter(function (c) { return c.status === 'fail' || c.status === 'warn'; });
    if (bad.length) { L.push(''); L.push('Checks that did not pass:'); bad.forEach(function (c) { L.push('- [' + c.status + '] ' + c.group + ': ' + c.title + ' | ' + c.detail); }); }
    return L.join('\n');
  }

  var api = { validateFile: validateFile, requirements: requirements, openPdb: openPdb, symbolicate: symbolicate, demangle: demangle, SEV: SEV, RULES: RULES, parseGameLog: parseGameLog, parseCrashXml: parseCrashXml, parseCrashIni: parseCrashIni, parseMinidump: parseMinidump, sniff: sniff, assemble: assemble, analyze: analyze, toText: toText, scrub: scrub, fmtDur: fmtDur, hash8: hash8 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.BR = api;
})(typeof window !== 'undefined' ? window : this);
