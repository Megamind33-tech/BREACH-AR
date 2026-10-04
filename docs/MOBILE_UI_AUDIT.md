# Mobile app: "AI slop" and accessibility audit

Method: a read of every screen's code against two lists (what makes an interface look machine-generated and noisy; WCAG 2.1 AA), colour contrast computed from the actual palette, and fixes applied. **Not done:** no screen reader (TalkBack) run, no large-font or reduced-motion run on a device. The phone was unplugged, so none of the changes below have been looked at on screen yet.

## What was slop, and what happened to it

| Finding | Why it reads as generated | Action |
|---|---|---|
| Scan beam sweeping the device picture, breathing corner marks, blinking cursor, a "live" beam every 9 s | Motion with no information, on a loop, looks like a demo reel; tiring for people waiting | **Removed.** `ScanPanel`: the device picture, a determinate bar, "N of M checks", the name of the check running. Only the bar moves. |
| Staggered "rise and fade" reveals, spring-popping ticks, haptic ticks and a buzz, a 1.1 s celebratory hold before results | Choreography that delays the answer | **Removed.** Results appear when they arrive. |
| Press-scale bounce on every card and button | Everything wiggles | **Removed.** Standard Android press feedback is back (it had been switched off, which also hid the pressed state). |
| Corner "viewfinder" marks on every photo and card | A gimmick repeated until it means nothing | **Removed.** |
| Green radial glow behind every page; gradient primary button; gradient card fills and lit-edge borders | Default "premium dark UI" decoration | **Removed.** Flat surfaces, one hairline, a flat green button. |
| Stock photos used as decoration (Check cards, first-run choices, quick-action tiles, Rescue tiles, Devices/Alerts/You/Plus banners) | Filler imagery with a colour grade on top | **Removed.** Photos remain only where they carry information (the picture of the actual gadget; the three onboarding pages you asked for). Seven unused photos deleted (-0.5 MB). Rescue is a plain list. |
| "Look deeper.", "Your devices. Your control.", "Your computers, in one place", the "Good morning." headline, "Nothing to look up" | Slogans that say nothing | **Removed or made plain.** |
| Onboarding page 3 said "Your family": there is no family feature | A promise the product does not keep | **Rewritten** to what is true. |
| A 0.34 s pause after each deep-audit step and a progress screen for a read that takes under a second | Fake effort | **Removed.** The button says "Auditing…" and results appear. |
| Slide transitions between onboarding pages | | Shortened to a 160 ms fade. |

What is left that moves: the bottom-bar selection colour (220 ms), status dot colour (240 ms), the indeterminate search bar and spinner (indicators, which stand still when Android's animations are off), a 200 ms fade on the onboarding photo.

## Accessibility (WCAG 2.1 AA)

Contrast, computed from the palette (needs 4.5:1 for text, 3:1 for large text and UI):

| Pair | Ratio | Pass |
|---|---|---|
| Dark: text on background | 18.3 | yes |
| Dark: secondary text on background / on card | 7.6 / 6.7 | yes |
| Dark: green on background / on card | 11.4 / 10.1 | yes |
| Dark: attention (amber) on card | 9.2 | yes |
| Dark: critical (red) on card | 5.8 | yes |
| Dark: button text on green | 10.9 | yes |
| Light: secondary text on background / on card | 5.9 / 5.5 | yes |
| Light: green on white / on background | 5.4 / 5.0 | yes |
| Light: attention on white, critical on white | 5.1, 6.5 | yes |
| Light: white text on green button | 5.4 | yes |

Not computed: text over photographs (it sits on a dark gradient scrim, so it should pass, but a photo can defeat a scrim); status pill text on its tinted fill.

| # | Issue | Criterion | Status |
|---|---|---|---|
| 1 | Back button 40 dp | 2.5.5 target size | **Fixed**: 48 dp |
| 2 | Clickable rows had no role | 4.1.2 | **Fixed**: Button role |
| 3 | Bottom bar and tabs had their press feedback switched off and no selected state | 2.4.7, 4.1.2 | **Fixed**: `selectable`, Tab role, default feedback |
| 4 | Section titles not announced as headings | 1.3.1 | **Fixed** for section headers; page titles still plain text (open) |
| 5 | Error and notice strips not announced | 4.1.3 | **Fixed**: polite live region |
| 6 | Text fields: label not tied to the field | 3.3.2 | **Fixed**: merged semantics |
| 7 | Nine-digit code boxes read as empty | 4.1.2 | **Fixed**: "Nine digit code, N of 9 entered" |
| 8 | Fixed-height boxes would clip at large font sizes | 1.4.4 resize text | **Partly fixed** (hero card, code boxes use minimum heights); the device-card photo area and onboarding split are still fixed proportions (open) |
| 9 | Device pictures had no description | 1.1.1 | **Fixed**: "Picture of {name}. {Exact model / Similar model / ...}" |
| 10 | Scan progress not exposed as progress | 4.1.2 | **Fixed**: progress range semantics |
| 11 | Trend charts were pictures only | 1.1.1 | **Fixed**: spoken summary of first, last, low, high |
| 12 | Alert severity shown by colour only | 1.4.1 | **Fixed**: severity word added |
| 13 | Animations cannot be turned off | 2.2.2 | **Mostly**: ambient animation is gone; the remaining indicators honour Android's "remove animations" |
| 14 | Colour is never the only carrier of status elsewhere (pill and text) | 1.4.1 | holds |
| 15 | Page-title headings, grouped "card" reading order, TalkBack tab order | 1.3.1, 2.4.3 | **Not tested** |

## Priority for the next pass
1. Run TalkBack through onboarding, pairing, a scan and results; fix reading order and add page-title headings.
2. Set the system font to the largest size and the display size to the largest; fix whatever clips (onboarding, device cards).
3. Check the contrast of photo overlays and status pills with a measured tool on the device.
4. Look at every screen: this pass was done from code.
