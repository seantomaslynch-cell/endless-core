#!/usr/bin/env python3
"""
YouTube Playables / Mediacube pre-submission checker — adapted for Endless Core.

Usage:
    python3 playables_check.py path/to/index.html

Runs every check that maps to a past Mediacube rejection:
  - loads with zero console/page errors
  - first interstitial fires on game start
  - timed interstitial arms and fires at game over
  - rewarded ad fires on revive and only revives on success
  - pause fully locks out interaction (CSS pointer-events + elementFromPoint)
  - audio is silent (zero sound nodes) when muted, audible when unmuted
  - canvas still renders and the game stays interactive through an
    orientation change (Endless Core's fixed logical canvas means entity
    positions can't leave the viewport, so there's nothing to clamp — see
    the ADAPTATION NOTES below)
Plus a static scan of the HTML/JS/CSS for CSP / SDK requirements.

Requires: pip install playwright ; playwright install chromium

ADAPTATION NOTES (this file was originally written for a different game —
a side-scrolling runner with a circular player and coins[]/obstacles[]
arrays — and has been adapted here to Endless Core's actual architecture,
not the other way around):

  1. static_scan() originally only read the HTML file. Endless Core splits
     logic into game.js and style.css, so every hook the spec requires
     (onPause/onResume, firstFrameReady/gameReady, saveData, requestRewardedAd,
     requestInterstitialAd, orientationchange, the body.paused CSS rule)
     lives in those sibling files, not index.html itself. Fixed to read and
     combine all three so the substring checks actually find anything.

  2. "no external scripts besides SDK" used to flag ANY non-SDK <script src>,
     which would incorrectly flag Endless Core's own local game.js. Fixed to
     only flag scripts loaded from a different origin (http(s):// or
     protocol-relative URLs other than the YouTube SDK) — a local relative
     path is not an external/CDN resource.

  3. The runtime "no revive when reward=false" check originally asserted
     against a global `gameActive`, which doesn't exist in Endless Core (or,
     as far as I can tell, in the original game this harness was written
     for either) — `typeof gameActive !== 'undefined'` is always false, so
     the assertion was vacuously true regardless of actual behavior. Fixed
     to check the real state flag (`state.running`).

  4. The pause-lockout debug output looked for `#pauseOverlay`; Endless
     Core's element is `#pause-overlay`. This never affected the actual
     pass/fail (that only depends on the button's computed pointer-events),
     just the debug detail — fixed for accuracy.

  5. The original audio test called a global `SFX` object (SFX.init,
     SFX.setEnabled, SFX.coin(), ...) that doesn't exist here. Endless Core's
     real API is a top-level playSound(type) plus applySdkAudioState(bool)
     driven by ytgame.system.onAudioEnabledChange. Rewritten against that.
     Also added a real (trusted) Playwright mouse click before the audio
     assertions — Chrome's autoplay policy only unlocks an AudioContext on a
     TRUSTED user gesture; a page.evaluate()-dispatched synthetic pointerdown
     does not count, so without a real click the context stays 'suspended'
     and playSound() would no-op regardless of mute state, producing a false
     "0 nodes" pass for the WRONG reason.

  6. §5 orientation: per architecture notes, Endless Core's canvas is a
     fixed 360x640 logical resolution letterboxed via CSS — entity positions
     live entirely in that fixed space and cannot leave the viewport on
     resize/rotation, so there is no per-entity rescale/clamp step to test.
     Replaced the old player.x-bounds assertion (which depended on a
     player/coins/obstacles model this game doesn't have) with: after
     dispatching 'orientationchange' in both orientations, the canvas still
     has a nonzero rendered size and a button is present and clickable
     (i.e. the game is still up and interactive, not just not-crashed).

  7. CFG's player_var/coins_var/obstacles_var/player_home_frac deleted
     outright — Endless Core has no such variables (gold/stone/gas are block
     types in a terrain grid, not entity arrays; the player is `drill`, not
     a centered circle with a radius) and inventing them would just be
     testing something that isn't real.
"""
import sys, re, json, os

# Windows consoles default to cp1252, which can't encode the ✅/❌ used below —
# without this the script crashes on the RESULT line regardless of pass/fail.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# ── CONFIG: matches Endless Core's actual function/variable names ───────────
CFG = {
    "start_fn":        "startGame()",       # begins a run
    "end_fn":          "endGame()",         # ends a run (natural breakpoint)
    "revive_fn":       "watchAdRevive()",   # named rewarded-ad revive entry point
    "reward_id":       "endlesscore-revive",
    "interstitial_tick": "tickInterstitialTimer()",
    # No player_var / coins_var / obstacles_var / player_home_frac — Endless
    # Core has no such variables (see ADAPTATION NOTES §7 above).
}

MOCK_SDK = """
window.__adCalls = [];
window.__pauseCb = null; window.__resumeCb = null; window.__audioCb = null;
window.__audioState = true;
window.ytgame = {
  IN_PLAYABLES_ENV: true,
  game: { firstFrameReady:()=>{}, gameReady:()=>{}, saveData:async()=>{}, loadData:async()=>null },
  system: {
    isAudioEnabled: ()=>window.__audioState,
    onAudioEnabledChange:(cb)=>{ window.__audioCb=cb; },
    onPause:(cb)=>{ window.__pauseCb=cb; },
    onResume:(cb)=>{ window.__resumeCb=cb; },
  },
  engagement: { sendScore:()=>{}, openYTContent:()=>{} },
  ads: {
    requestInterstitialAd: async()=>{ window.__adCalls.push({type:'interstitial'}); },
    requestRewardedAd: async(id)=>{ window.__adCalls.push({type:'rewarded',rewardId:id});
      return window.__rewardResult===undefined?true:window.__rewardResult; },
  },
  health:{ logError:()=>{}, logWarning:()=>{} },
};
"""

def static_scan(path):
    game_dir = os.path.dirname(path)
    html = open(path, encoding="utf-8").read()

    js = ""
    js_path = os.path.join(game_dir, "game.js")
    if os.path.exists(js_path):
        js = open(js_path, encoding="utf-8").read()

    css = ""
    css_path = os.path.join(game_dir, "style.css")
    if os.path.exists(css_path):
        css = open(css_path, encoding="utf-8").read()

    combined = html + "\n" + js + "\n" + css  # for substring checks that can live in any file
    results = []
    def chk(name, ok): results.append((name, bool(ok)))

    # Structural checks: only meaningful against the HTML's own <script> tags.
    first_script_idx = html.find("<script")
    sdk_idx = html.find("game_api/v1")
    chk("SDK is first <script>", first_script_idx != -1 and sdk_idx != -1 and first_script_idx < sdk_idx < first_script_idx + 200)
    chk("0 inline HTML on*= attrs", len(re.findall(r"<[^>]+\son\w+\s*=", combined)) == 0)

    # A script src is "external" only if it points at a different origin
    # (absolute http(s):// or protocol-relative) that isn't the YouTube SDK
    # itself. A local relative path like "game.js" is part of this game's
    # own bundle, not a CDN/third-party resource.
    other_srcs = [s for s in re.findall(r'<script[^>]+src="([^"]+)"', html) if "game_api" not in s]
    external_srcs = [s for s in other_srcs if re.match(r'^(https?:)?//', s)]
    chk("no external scripts besides SDK", len(external_srcs) == 0)

    chk("no Page Visibility API", "visibilitychange" not in combined and "document.hidden" not in combined)
    chk("onPause + onResume", "onPause" in combined and "onResume" in combined)
    chk("firstFrameReady + gameReady", "firstFrameReady" in combined and "gameReady" in combined)
    chk("saveData present", "saveData" in combined)
    chk("rewarded ad call", "requestRewardedAd" in combined)
    chk("interstitial ad call", "requestInterstitialAd" in combined)
    chk("pause body-lockout CSS", "body.paused" in combined)
    chk("orientationchange handled", "orientationchange" in combined)
    chk("no TikTok leftovers", "tt.show" not in combined and "showRewardedVideoAd" not in combined)
    return results

def runtime_checks(path):
    from playwright.sync_api import sync_playwright
    url = "file://" + path
    out = []
    with sync_playwright() as p:
        # Headless Chromium's autoplay policy doesn't reliably treat even a
        # CDP-dispatched pg.mouse.click() as a trusted user gesture, so
        # audioCtx can stay 'suspended' regardless of mute state — this flag
        # removes that dependency so the audio test actually exercises
        # playSound()'s mute branch instead of failing before it's reached.
        b = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
        pg = b.new_page(viewport={"width":390,"height":844})
        errors = []
        pg.on("console", lambda m: errors.append(m.text) if m.type=="error" else None)
        pg.on("pageerror", lambda e: errors.append("PAGEERROR: "+str(e)))
        pg.route("**/game_api/v1", lambda r: r.fulfill(status=200,
                 content_type="application/javascript", body=MOCK_SDK))
        pg.goto(url); pg.wait_for_timeout(1500)

        out.append(("loads with 0 console/page errors", len(errors)==0, errors[:5]))

        # first interstitial
        pg.evaluate(CFG["start_fn"]); pg.wait_for_timeout(400)
        calls = pg.evaluate("window.__adCalls")
        out.append(("first interstitial on start", any(c['type']=='interstitial' for c in calls), calls))

        # pause lockout
        pg.evaluate("window.__pauseCb && window.__pauseCb()"); pg.wait_for_timeout(200)
        st = pg.evaluate("({paused: (typeof isPaused!=='undefined'&&isPaused), body: document.body.classList.contains('paused')})")
        reach = pg.evaluate("""() => {
            const btn = document.querySelector('button');
            if(!btn) return {pe:'no-button', overlayOnTop:true};
            const r = btn.getBoundingClientRect();
            const el = document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
            return { pe: getComputedStyle(btn).pointerEvents,
                     overlayOnTop: !!(el && el.closest && el.closest('#pause-overlay')) };
        }""")
        pause_ok = st["paused"] and st["body"] and reach["pe"]=="none"
        out.append(("pause fully locks interaction", pause_ok, {**st, **reach}))
        pg.evaluate("window.__resumeCb && window.__resumeCb()"); pg.wait_for_timeout(200)
        out.append(("resume clears pause", not pg.evaluate("(typeof isPaused!=='undefined'&&isPaused)"), None))

        # rewarded ad — success then failure
        pg.evaluate("window.__adCalls=[]; window.__rewardResult=true; " + CFG["end_fn"]); pg.wait_for_timeout(200)
        pg.evaluate(CFG["revive_fn"]); pg.wait_for_timeout(400)
        calls2 = pg.evaluate("window.__adCalls")
        out.append(("rewarded ad fires w/ id", any(c['type']=='rewarded' and c.get('rewardId')==CFG['reward_id'] for c in calls2), calls2))
        pg.evaluate("window.__rewardResult=false;")
        pg.evaluate(CFG["end_fn"]); pg.wait_for_timeout(150)
        pg.evaluate(CFG["revive_fn"]); pg.wait_for_timeout(400)
        # real state flag — the original check referenced a nonexistent
        # `gameActive` global and was vacuously true regardless of behavior.
        out.append(("no revive when reward=false", not pg.evaluate("(typeof state!=='undefined'&&state.running)"), None))

        # timed interstitial
        pg.evaluate("window.__adCalls=[]")
        pg.evaluate("try{lastInterstitialTime=Date.now()-91000;interstitialArmed=false;firstInterstitialShown=true;}catch(e){}")
        pg.evaluate("try{%s;}catch(e){}" % CFG["interstitial_tick"])
        pg.evaluate(CFG["end_fn"]); pg.wait_for_timeout(300)
        out.append(("timed interstitial at game over", any(c['type']=='interstitial' for c in pg.evaluate("window.__adCalls")), None))

        # audio mute/unmute — Endless Core's real API: playSound(type) plus
        # applySdkAudioState(bool). A real (trusted) click is required first:
        # Chrome's autoplay policy only unlocks an AudioContext on a trusted
        # user gesture, and a page.evaluate()-dispatched synthetic pointerdown
        # doesn't count — without this the context stays 'suspended' and
        # playSound() no-ops regardless of mute state, which would report
        # "0 nodes" for the wrong reason on BOTH sides of the test.
        pg.mouse.click(195, 400)
        pg.wait_for_timeout(200)
        audio = pg.evaluate("""async () => {
            return await new Promise(res => {
              let muted = 0, unmuted = 0;
              const orig = OscillatorNode.prototype.start;
              OscillatorNode.prototype.start = function(...a) {
                // sdkAudioEnabled is declared with `let` at game.js's top level —
                // unlike var/function declarations, let/const do NOT attach to
                // `window`, so a bare reference (not window.sdkAudioEnabled) is
                // required to resolve it through the normal scope chain.
                (sdkAudioEnabled ? unmuted++ : muted++);
                return orig.apply(this, a);
              };
              const types = ['coin','hit','dig','relic','explosion','toast'];
              window.applySdkAudioState(false);
              types.forEach(t => { try { window.playSound(t); } catch(e){} });
              setTimeout(() => {
                window.applySdkAudioState(true);
                types.forEach(t => { try { window.playSound(t); } catch(e){} });
                setTimeout(() => {
                  OscillatorNode.prototype.start = orig;
                  res({ muted, unmuted });
                }, 100);
              }, 100);
            });
        }""")
        out.append(("muted = 0 sound nodes", audio["muted"]==0, audio))
        out.append(("unmuted > 0 sound nodes", audio["unmuted"]>0, audio))

        # orientation — see ADAPTATION NOTES §6. Fixed logical canvas means
        # there's no entity-bounds check to do; instead verify the canvas
        # still renders and the game is still interactive after rotating
        # both ways.
        pg.evaluate("try{%s;}catch(e){}" % CFG["start_fn"]); pg.wait_for_timeout(300)

        pg.set_viewport_size({"width":844,"height":390})
        pg.evaluate("window.dispatchEvent(new Event('orientationchange'))"); pg.wait_for_timeout(300)
        land = pg.evaluate("""() => {
            const c = document.getElementById('gameCanvas');
            const r = c.getBoundingClientRect();
            const btn = document.querySelector('button:not([disabled])');
            return { canvasW: r.width, canvasH: r.height, hasClickableButton: !!btn };
        }""")

        pg.set_viewport_size({"width":390,"height":844})
        pg.evaluate("window.dispatchEvent(new Event('orientationchange'))"); pg.wait_for_timeout(300)
        port = pg.evaluate("""() => {
            const c = document.getElementById('gameCanvas');
            const r = c.getBoundingClientRect();
            const btn = document.querySelector('button:not([disabled])');
            return { canvasW: r.width, canvasH: r.height, hasClickableButton: !!btn };
        }""")

        orientation_ok = (land["canvasW"] > 0 and land["canvasH"] > 0 and land["hasClickableButton"] and
                           port["canvasW"] > 0 and port["canvasH"] > 0 and port["hasClickableButton"])
        out.append(("canvas renders + game interactive after rotate", orientation_ok, {"landscape":land,"portrait":port}))

        b.close()
    return out

def main():
    if len(sys.argv) < 2:
        print("usage: python3 playables_check.py path/to/index.html"); sys.exit(2)
    path = sys.argv[1]
    if not path.startswith("/"):
        path = os.path.abspath(path)

    print("="*60); print("STATIC SCAN"); print("="*60)
    passed = True
    for name, ok in static_scan(path):
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}"); passed &= ok

    print("\n"+"="*60); print("RUNTIME CHECKS"); print("="*60)
    try:
        for row in runtime_checks(path):
            name, ok = row[0], row[1]
            detail = row[2] if len(row) > 2 else None
            print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f"   {detail}" if (detail and not ok) else ""))
            passed &= ok
    except Exception as e:
        print("  runtime checks could not run:", e)
        print("  (install: pip install playwright ; playwright install chromium)")
        passed = False

    print("\n"+"="*60)
    print("RESULT:", "ALL PASS ✅ — safe to submit" if passed else "FAILURES ❌ — fix before submitting")
    print("="*60)
    sys.exit(0 if passed else 1)

if __name__ == "__main__":
    main()
