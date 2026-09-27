# BREACH AR — tester guide (no Unity knowledge needed)

## You need
* An **ARCore-supported Android phone** (Android 10+). List: https://developers.google.com/ar/devices
* The file **BREACH-dev.apk** (GitHub → Actions → latest "BREACH build" run → Artifacts → `BREACH-dev-apk`, unzip).
* Optional for now (needed for the shared-world stage later): the printed origin marker, `docs/marker/BREACH_origin_marker_A4.pdf`, printed at 100% scale.

## Install
1. Copy the APK to the phone and open it. Allow "install unknown apps" for your file manager when asked.
2. Launch **BREACH AR**. Allow camera access. If asked, install/update **Google Play Services for AR**.

## Play (about 3 minutes)
1. **PLAY** (or **TRAINING** — you cannot die, unlimited ammo).
2. Read the safety screen, clear ~3 m around you, tap **I'M CLEAR**.
3. **Scan**: sweep the phone slowly over the floor until the bar fills, then look at nearby walls and furniture (this gives the Hunter places to hide). Tap **BEGIN** where you want to fight.
4. After the countdown, the Hunter enters **out of your view**. Listen for it — it growls when unseen. Turn and search.
5. **Fire**: press and hold anywhere on the right half of the screen (left half if you changed FIRE SIDE in Settings). Aim with the small crosshair; it rises with recoil.
6. **Reload**: tap the ammo counter (bottom right), or pull the trigger on an empty magazine.
7. It attacks at close range — back away during its wind-up to make it miss. Headshots do the most damage.
8. Each kill scores and the next, bolder encounter begins. The match ends when you are taken.

## Co-op (two phones)
1. Print `docs/marker/BREACH_origin_marker_A4.pdf` at 100% scale and lay it flat on the floor in the middle of the room.
2. Both phones on the **same Wi-Fi**.
3. Phone A: **CO-OP → HOST**. It shows a room code such as `1.37`.
4. Phone B: **CO-OP → JOIN**, type the code on the keypad, **JOIN**. Both lobbies should list ALPHA and BRAVO.
5. Phone A: **START**. Both phones go through the safety and scan screens.
6. On **both** phones, point the camera at the marker until the scan screen stops saying "SCAN THE BREACH MARKER". Hold steady while it calibrates. Then press **BEGIN**, phone B first, then the host.
7. Check alignment: a small blue diamond with your teammate's callsign should float **right on their phone**. If it's off by more than a hand's width, pause → RECALIBRATE ORIGIN and scan the marker again. Report how far off it was.
8. Fight. Both phones should see the **same Hunter in the same place**. Either player can damage it; the score is shared. If you're downed, you get back up when your teammate kills the Hunter. The match ends when everyone is down.
9. Export a diagnostics report from **both** phones. The NETWORK section shows ping, pose freshness and hit-claim counts.

## Send results back
1. Open **Diagnostics**: Settings → DIAGNOSTICS, or Pause (top-left) → DIAGNOSTICS, or **press and hold** the pause icon for about a second during a fight.
2. Tap **EXPORT TEST REPORT**. Choose any app (email, chat) to send it — it is also copied to the clipboard.
3. Add a few words: what felt wrong, what looked cheap, did the Hunter appear to stand on your floor, could you hear where it was?

## What to look for
* Does the Hunter stand **on** your floor (not floating, not sinking)?
* Does it disappear **behind real walls/furniture** (needs a phone with depth support; the report's `depth` line says whether it is active)?
* Is the rifle audible and punchy on the **phone speaker** and on headphones?
* Frame rate: the report's `fps avg` / `fps 1% low`.
