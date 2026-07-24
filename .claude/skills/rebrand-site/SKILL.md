---
name: rebrand-site
description: Use when the user wants to launch/redesign a new brand on this Astro slot-site template — swapping in a new name, a docx content brief, and reference images (logo/banner/slides) in src/assets, while reusing the existing component library. Triggers on requests like "เว็บใหม่ชื่อ...", "redesign ตาม ref รูปที่แนบมา", "ตรวจสอบ SmoothCarousel/Promotion", or any ask to retheme index.astro from a new brand's assets + docx without deleting existing components. A full rebrand runs as the 2-agent parallel workflow below BY DEFAULT (this repo's owner has standing approval for it) — you do not need the user to say "ขนาน"/"parallel" each time. Only fall back to fully sequential when the user explicitly asks for it (e.g. "ทีละสเต็ป", "sequential", "อย่าแตก agent") or when the task is a Phase 7 single-component follow-up, where parallelizing isn't worth it.
---

# Rebrand this Astro site to a new brand

This repo is a shared Astro template reused across many Thai slot/casino
client sites (see the `NavbarStyle*`, `FooterStyle*`, `ContentBox*Premium/Cyber/Huay`
variants in `src/components`). "Launching a new brand" means: swap the
content and color palette to match a new client's docx brief and image
assets, while reusing the existing component tree — never deleting or
skipping a component `index.astro` already imports.

Work through these phases in order. Don't skip the verification phase —
every past run of this skill has caught at least one real bug there.

**Build cadence: run `npm run build` exactly ONCE, in Phase 5 — not
between edits.** A full `astro build` is the single most expensive step
in this workflow, and rebuilding after each component/page wastes most
of the wall-clock time a rebrand takes. Do all the editing across
Phases 2–4.5 first, then build once at the start of Phase 5 and run
every `dist/`-based grep check against that one build. The only time
you build again is if Phase 5 surfaces a bug and you fix it — then one
more build to confirm. Any instruction in an earlier phase that says
"verify with `npm run build` then grep `dist/…`" means *defer that grep
to the Phase 5 build*, not kick off a build then and there.

## Optional: run the rebrand as 2 parallel subagents

**Default for full rebrands.** Run a full rebrand this way *by default* —
the repo owner has given standing approval, so you do **not** need the
user to type "ขนาน"/"parallel" each time (though those cues still apply).
Fall back to fully sequential only when the user explicitly asks
("ทีละสเต็ป", "sequential", "อย่าแตก agent") or when the task is a Phase 7
single-component follow-up (parallelizing one component isn't worth the
spawn cost — do those yourself). This mode changes *who* runs Phases
2–4.5 and in what order — **not what those phases do**. Every rule in
Phases 1–7 still applies in full to each subagent; nothing here relaxes
them.

The split is **by non-overlapping files, never by "type of work."** Two
subagents must never edit the same file — so the shared "chrome" that
renders on *every* page has to be finished *before* the fan-out, by you,
not by either subagent.

**Step P0 — you (orchestrator) do Phase 1 + the variant-selection part
of Phase 2 yourself, up front.** Extract the docx, read the images, pick
each family's variant (Navbar / Footer / Announcement / LatestWinners /
ContentBox-mix per the Phase 2 rotation rule), and write brand name +
palette (old→new hex + Tailwind hue) + chosen variants + the numbered
docx-heading checklist into **one** scratchpad "brand spec" file. Both
subagents read that single file — they must **not** re-extract the docx
or re-pick variants (that would risk two agents choosing differently).

**Step P1 — you retheme the SHARED chrome sequentially, before fan-out,
then commit it as the baseline both agents build on.** Compute the shared
set *each run* (don't trust a stale list — variant rotation changes which
navbar/footer is active): the active `MainLayout.astro` + the single
`Navbar*`/`Footer*` it imports + `Navfoot.astro`, **plus any component
imported by ≥2 files under `src/pages/`** (grep the page-level imports to
find them; as of the 999LORD brand that extra set is `ContentBox.astro`
and `Announcement4.astro`). Retheme all of these per Phase 3. This is the
collision zone; getting it done first is what makes the two agents
disjoint.

**Step P2 — fan out exactly two subagents (`Agent` tool), zero file
overlap:**
- **Agent A — Landing.** Owns `src/pages/index.astro` and every component
  *only* index renders — built **recursively** (e.g. `LoginRtpSection` →
  `ContentBoxTwo`), MINUS every file in the P1 shared set. Runs Phase 2
  (content mapping) + Phase 3 + Phase 4 (stale-asset fixes) for those
  files.
- **Agent B — Sub-pages.** Owns every *other* `src/pages/*.astro` and the
  components *only* those pages render (e.g. `AnnouncementHuay`,
  `ContentBoxHuay`), MINUS the P1 shared set. Runs Phase 4.5 for those
  pages (including the `Huay`-theme exception).

Each subagent's brief MUST state, explicitly: (1) the exact file list it
owns; (2) a **"do NOT touch"** list = the P1 shared-chrome files + the
other agent's files; (3) the Phase-2 rule that unused component variants
are inventory and must never be deleted; (4) "read the brand-spec
scratchpad file for name/palette/variants; do not re-extract the docx or
re-choose variants"; (5) **"do NOT run `npm run build`"** — the single
build stays with you in Phase 5, per the build-cadence rule above. A
subagent that builds mid-flight both wastes the most expensive step and
can't see the other agent's not-yet-merged edits anyway.

**Step P3 — you merge + verify.** After both agents report back, run
Phase 5 (the one build), Phase 6 (workspec), and any Phase 7 follow-ups
yourself. If verification shows a shared-chrome component needs a further
change, make it **yourself** in this step — never send a subagent back
into the shared set after fan-out.

**Fallback — when the split can't be made clean:** if a component you
need to retheme is shared across both zones (so neither agent can own it
safely), pull it into the P1 shared step and retheme it there instead of
splitting it. Fewer files in the parallel zone is always safer than a
collision; when in doubt, widen P1 and shrink the fan-out.

## Phase 1 — Gather brand inputs

1. **Find the brief.** Look for a `.docx` file dropped into `src/assets`
   or `src/components` (past runs named it `<brand>-content.docx`). The
   `Read` tool cannot open `.docx` directly — extract text with a
   zip+regex pass instead:
   ```bash
   unzip -o "<path-to.docx>" -d "$SCRATCHPAD/docx_extract"
   python -c "
   import re
   with open(r'$SCRATCHPAD/docx_extract/word/document.xml', encoding='utf-8') as f:
       xml = f.read()
   paras = re.findall(r'<w:p[ >].*?</w:p>', xml, re.DOTALL)
   out = [''.join(re.findall(r'<w:t[^>]*>(.*?)</w:t>', p, re.DOTALL)) for p in paras]
   print(chr(10).join(out))
   "
   ```
   On Windows/git-bash, pass Windows-style paths (`C:/Users/...`) to
   `python`, not `/c/Users/...` posix paths — the python.exe on this
   box doesn't resolve those. `unzip` may exit 2 with a harmless
   trailing-bytes warning; check the extracted files landed before
   worrying about it.
2. **Read every reference image** in `src/assets` with the `Read` tool
   (it renders images visually) — logo, banner(s), slide(s), bg. Note:
   - the dominant color palette (this becomes the new theme's accent
     colors, replacing the old brand's)
   - the mood/genre (ocean, neon-cyberpunk, gold-luxury, etc.) — this
     drives which existing component *variant* families
     (`*Premium`, `*Cyber`, `*Huay`, plain) best fit, if the user says
     you may pick from the wider component library
   - if the user pastes one specific image path as "ref", treat it as
     the primary hero reference (see Phase 4 hero-selection bug).
   - **`banner*` splits into two roles by number, `slide*` is content.**
     `banner1` is the site's single **hero** banner (the one
     `MainLayout.astro`'s glob picks — see Phase 4); every **higher-
     numbered banner (`banner2`, `banner3`, `banner4`)** is a spare
     **article-illustration image** for composing the front page, *not*
     another hero candidate. This is what the `tools/rebrand-uploader`
     UI stages them as (`banner1` = hero, `banner2-4` = "รูปประกอบ
     บทความ").
   - **`banner2/3/4` go INSIDE a single-column `ContentBox` as a
     resized inline illustration — never a `ContentBoxSevenThree`
     column, never a full-width strip, never the hero.** Pick the
     single-col docx section the banner best fits (e.g. a cashback/
     bonus banner → the register/promo section), drop the image into
     that box's slot, and **cap its width so it sits "พอดี"** — e.g.
     `mx-auto h-auto w-full max-w-2xl rounded-2xl` — not edge-to-edge.
     Only use a `banner2+` file that belongs to the *current* asset
     drop (check the mtime / that it's not a stale leftover from an
     older brand — a `banner3.png` dated before the new `banner1/2`
     drop is old inventory, skip it). It's fine to leave a `banner2+`
     unused if no section fits; don't force it or turn it into a hero.
3. Confirm the new brand name and check `astro.config.mjs` `site:` —
   it's often already been updated to the new domain before you're
   asked to do the content work.

**Never invent a domain from the brand name.** A bare "rebrand to
`<brand>`" request is content/design work only — it does *not* license
guessing a URL like `https://www.<brand>.com` from the brand name, a
reference image, or the docx (a past run guessed a domain off a
reference image that happened to show a URL, and it was wrong). Leave
`astro.config.mjs`'s `site:`, `public/robots.txt`'s `Sitemap:` line,
and any hardcoded `url:` string literal in `index.astro`'s
`webSiteSchema`/similar schema.org objects exactly as they already are
— even if they still show a previous brand's domain, that's expected
drift, not something to silently "fix." Only touch those three spots
when the user explicitly gives a real URL alongside the brand name
(e.g. "rebrand to `<brand>` and real url `<XXXX>`"), and then set all
three to that exact URL — don't miss the schema.org one, it's a plain
string literal that doesn't auto-follow `site:` the way
`Astro.url.origin`-derived values do.

## Phase 2 — Map docx content onto existing component slots

List every component `src/pages/index.astro` currently imports and
uses. **Never remove one** — if an import is unused (check with Grep
for `<ComponentName` in the JSX body, not just the import line), that's
a bug in the current file: wire it up with real content instead of
deleting the import. (Past run: `Faq`/`FaqHuay` was imported but never
rendered, and its *default* prop content was a leftover FAQ from a
totally different old brand — fixed by passing a `faqs` prop with new
content, not by editing the shared component's defaults.)

Map each docx H1/H2/H3 section onto one existing slot 1:1 — most of
these templates have: hero title, an intro `ContentBox`, a two-column
`ContentBoxTwo` (often a login widget + a stats/provider table), a
three-column `ContentBox3Three`/`ContentBoxThreeColums`, at most one or
two image+text `ContentBoxSevenThree` blocks (see the hard 2-max rule
below — lean on single-column `ContentBox*` and two-column
`ContentBoxTwo*` for the rest), a `ContentBoxSpecial` two-half block,
review cards, and a FAQ. Don't
invent new sections or duplicate content across two slots — if the
docx has fewer sections than slots, some slots keep more generic
copy; if it has a specific list of game providers/payment methods,
prefer real values in **both** the provider grid/table props and any
provider-name mentions in prose paragraphs, so they don't contradict.

**Don't reach for plain `ContentBox` for every single section — use the
whole component "family," and this applies to every repeated family in
the repo, not just `ContentBox`.** `src/components/` groups many
sections into a base file plus mood-suffixed siblings — `Premium`,
`CyberCut`, `FloatingBadge`, `Huay`, `Neumorphism`, `Cyber`, plus
numbered `Style1..11` for navbars — different *shapes*, not just
different colors:
- `ContentBox`/`ContentBoxSevenThree`/`ContentBox3Three`/`ContentBoxTwo`
  — content section wrappers (see the image-pairing note below).
- `Announcement`/`Announcement2..6`/`AnnouncementCyber`/
  `AnnouncementPremium`/`AnnouncementHuay` — the scrolling top ticker.
  Every variant's `message` prop **defaults to a different old brand's
  slogan** (a past run found defaults for six unrelated old brands
  across this one family alone) — when you pick a variant, you must
  always pass an explicit `message` prop with the current brand's copy;
  never leave the default in place assuming it's generic filler.
- `LatestWinners`/`LatestWinners2..4`/`LatestWinnersCyber`/
  `LatestWinnersPremium`/`LatestWinnersHuay` — the live withdrawal/win
  feed. These are self-contained (own bank-logo imports, own mock-data
  generator script) but the brand name and hue are hardcoded straight
  into the JSX, not passed as props — swapping variants means doing the
  full retheme + brand-name pass on the newly chosen file, same as any
  other component in Phase 3.
- `Navbar`/`NavbarStyle1..11`/`NavbarCyber`/`NavbarHuay`/
  `NavbarPremium` and `Footer`/`FooterStyle2..3`/`FooterCyber`/
  `FooterHuay`/`FooterPremium`(`Sumo`) — **unlike the families above,
  only one navbar file and one footer file are ever active at once**,
  imported directly into `MainLayout.astro`. "Picking a variant" here
  means choosing which single file to point `MainLayout.astro`'s
  import at (and updating that one import), not composing several on
  one page. Whichever one you pick, it almost certainly still has the
  *previous* brand's name hardcoded in a logo-fallback heading and
  footer copyright line (exactly like the currently-wired one did) —
  retheme and swap that text before wiring it in, not after.

**Rotate every family's variant on each rebrand — the ONE variant you
must not reuse is the one the previous brand had wired in.** This is a
hard rule, not a nice-to-have: these are unrelated clients on a shared
template, and two consecutive brands must not come out looking like the
same site with new colors. Before writing `index.astro`/`MainLayout.astro`,
for each family below, first *identify the outgoing brand's current pick*
(grep the live imports in `src/pages/index.astro` and
`src/layouts/MainLayout.astro`), then **deliberately choose a different
sibling** for the new brand — a different *shape*, not just a recolor of
the same one:
- **ContentBox family** (`ContentBox`/`*Premium`/`*CyberCut`/
  `*FloatingBadge`/`*SevenThree*`/`*3Three*`/`*Special`) — if the last
  brand leaned on `FloatingBadge` + `CyberCut`, this brand should lead
  with a different mix (e.g. `Premium` + plain + `Special`). Vary which
  shape carries the H1 hero vs the H2 sections.
- **Announcement family** (`Announcement`/`Announcement2..6`/
  `*Cyber`/`*Premium`/`*Huay`) — switch to a different ticker number/
  suffix than the one currently imported.
- **LatestWinners family** (`LatestWinners`/`2..4`/`*Cyber`/`*Premium`/
  `*Huay`) — pick a different feed variant than the live one, then do
  the full retheme + brand-name pass on the newly chosen file (its hue
  and brand name are hardcoded in JSX, not props).
- **Navbar / NavbarStyle family** (`Navbar`/`NavbarStyle1..11`/
  `*Cyber`/`*Huay`/`*Premium`) — point `MainLayout.astro` at a
  *different* single navbar file than the outgoing brand's, and retheme
  it. Only one is active at a time, so "rotating" here means changing
  which one file the layout imports.
- **Footer family** (`Footer`/`FooterStyle2..3`/`*Cyber`/`*Huay`/
  `*Premium`(`Sumo`)) — same as navbar: switch `MainLayout.astro` to a
  different single footer file and retheme it.

If a family genuinely has no better-fitting alternative for this brand's
mood and you must reuse the previous variant, say so explicitly in the
`workspec.md` entry with the reason — don't silently leave the old pick
in place. The default expectation on every rebrand is: different navbar,
different footer, different announcement, different winners feed, and a
visibly different ContentBox shape-mix than the brand before.

For every family, two things before wiring a new variant in:
1. **Retheme it first.** These variants ship in whatever color family
   a past brand used (often purple or emerald green) — grep-check with
   `grep -rln "ComponentName" src/pages/` that no *other* page already
   uses it (if none, it's safe to retheme in place), then swap its hue
   to the current brand's palette exactly like Phase 3, before dropping
   it into `index.astro` or `MainLayout.astro`.
2. **Check its heading tags before use**, same rule as the heading-tags
   note above — some variants (e.g. a `SevenThree*FloatingBadge`'s
   `titleleft`/`titleright`) hardcode a different level than others.
   Normalize to match the docx's level for every variant you introduce,
   not just the ones you already had.
3. **Test any `*FloatingBadge` variant with a full-sentence docx
   heading before trusting it, not a short placeholder title.** These
   variants render their `title` inside a `position: absolute`,
   horizontally-centered pill badge with no width cap — a past run
   found every `FloatingBadge` file (`ContentBox`, `ContentBoxTwo`,
   `ContentBox3Three`, `ContentBoxSevenThree`) shipped with
   `whitespace-nowrap` on that badge, which was invisible in a desktop
   check but blew the badge past the viewport width on mobile the
   moment the title was a real docx sentence instead of a 2-3 word
   placeholder — cutting text off and forcing the whole page into
   horizontal scroll (no `<body>` `overflow-x: hidden` existed to
   contain it either). Before using any `*FloatingBadge` variant, grep
   it for `whitespace-nowrap` on the title badge and replace with a
   width cap (e.g. `w-[92%] max-w-2xl`) plus `text-center` so long
   titles wrap instead of overflowing, and confirm `MainLayout.astro`
   still has `overflow-x: hidden` on `html, body` as a second line of
   defense. Verify by checking the actual rendered badge at a mobile
   viewport width with the real (long) title text, not just that the
   build succeeds.

   **Same bug, vertical axis: check the badge doesn't overlap the
   card's own content once it wraps to 2 lines.** All three
   `*FloatingBadge` files position the title as `absolute -top-6`
   inside a card whose top padding (`pt-12`/`pt-14`/`pt-16`/`pt-18`) was
   sized for a *short, one-line* title. Do the arithmetic before
   trusting it: badge height ≈ (line-height × number of wrapped lines)
   + vertical padding + border, and its bottom edge sits at
   `badge height − 24px` (the `-top-6` offset) measured from the card's
   top. If that number is ≥ the card's `pt-*` value, the badge visually
   overlaps the slot content below it — this actually happened with a
   real two-line docx H2 title (`ContentBoxSevenThreeFloatingBadge`
   only reserved `pt-12`/48px; a 2-line mobile-size title came out to
   ~48-72px, i.e. zero or negative clearance) and was fixed by bumping
   the padding (`pt-12`→`pt-16`, `pt-14`→`pt-18` across all three
   `*FloatingBadge` files, kept in sync). Don't just eyeball a desktop
   screenshot with the badge on one line — resize to a narrow mobile
   width with the *actual* long title so it wraps, and confirm there's
   visible daylight between the badge's bottom border and the card's
   inner content.

**Keeping DOM depth shallow when rethemeing a ContentBox variant —
hoist redundant slot-wrapper `<div>`s, don't add new ones.** These
templates aim for shallow, HTML5-semantic markup (`section` → `article`
→ heading/content) for SEO; a repeated wrapper pattern quietly adds a
dead nesting level. In every *multi-column* variant (`*SevenThree*`,
`*3Three*`) each column is
`<article class="flex … gap-N"> <h2>…</h2> <div class="text-…"><slot/></div> </article>`
— that inner `<div>` exists only to carry **inheritable** text classes
(font-size / `leading-*` / text color), so it's a removable level: move
those classes onto the `<article>` and delete the `<div>`, letting the
slot render as a direct child. This is a *safe / zero-visual-change*
edit **only** when you handle the one property that leaks to the sibling
heading:
- Headings here set their own size/weight/color but **not**
  `line-height`, so a `leading-relaxed` hoisted onto the `<article>`
  would leak into the `<h2>` (Tailwind's `html` sets `line-height: 1.5`,
  so the heading currently renders at 1.5). Neutralize the leak by
  adding `leading-normal` (= 1.5, a genuine no-op) to every heading that
  is a flex-sibling of the hoisted slot. Confirm in the Phase 5 build
  (don't build now) by grepping `dist/index.html` that the `<article>`
  now carries the text classes and the wrapper `<div>` is gone.
- The single-child count must stay the same for `gap-N` to behave: this
  works because the *consumer* already wraps slot content in one element
  (`<div slot="right"><p>…</p></div>`). Don't flatten a case where the
  slot would inject multiple block children directly into the
  `gap-N` flex column — the gap would then apply between them and shift
  spacing.

**Do NOT flatten the single-slot variants the same way** (`ContentBox`,
`*Premium`, `*CyberCut`, `*FloatingBadge`, `*Huay`, `*Special`). Their
content wrapper carries `relative z-10` so text paints *above* the
decorative `absolute` aura/corner layers inside the card (or uses
`bg-clip-text`, which must stay on the text element itself). Hoisting
those classes away removes the stacking context and the decoration
paints over the text — a real regression, not a zero-change edit. Leave
them unless you also convert the decoration to `::before`/`::after`
pseudo-elements (a deliberate CSS change to verify visually, not a
"safe merge"). Applied this to HENGJUD365 on 2026-07-15: flattened the 5
live multi-column variants only; see that `workspec.md` entry.

When a docx has many sections (6+), pick a *different* `ContentBox*`
variant for several of them so the page has rhythm instead of eight
identical rounded cards in a row.

**Use the `ContentBoxSevenThree*` (image+text) family SPARINGLY — at
most TWICE per rebrand, ONCE if the docx is short.** The point of a
SevenThree block is to bring *one* image alongside text; it is NOT the
default section shape, and you do NOT need to give every slide its own
SevenThree. Hard limit: **2 `ContentBoxSevenThree*` blocks per rebrand**
(counting the whole family — plain/`*Premium`/`*CyberCut`/
`*Neumorphism`/etc. together). If the brand's docx has only a few
sections, use it **once**. Every other docx section should lean on
**single-column `ContentBox*` and two-column `ContentBoxTwo*`** instead
— those carry the bulk of the page.

**Pick exactly the 2 (or 1) `slide*` images that best illustrate their
sections for those SevenThree blocks; the rest of the slides can go
unused.** The image pool for SevenThree is the **`slide*` files only**
(`banner1` is the hero; `banner2/3/4` are single-column `ContentBox`
inline illustrations — see Phase 1, they do NOT go in a SevenThree
column). Read the slides with `Read`, choose the 2 whose drawn content
maps cleanly onto a docx section (e.g. a certification/SSL image → the
"licensed/standards" section, a speed-test image → the "performance
test" section), and don't feel obliged to place all four — leaving 2
slides unused is expected and fine. Note which slides you used vs left
out in the workspec.

**Every docx heading must survive, in document order, before you touch
theming.** Before writing a single line of `index.astro`, list out
*all* H1/H2/H3 lines from the Phase 1 extraction as a numbered
checklist (not just the ones that obviously map to an existing slot).
This catches two failure modes a past run actually hit:
- **Dropped sections.** It's easy to map the 5-6 headings that map
  cleanly onto existing slots and quietly skip the 2-3 that don't have
  an obvious home (e.g. a "site strengths / usage results" heading, or
  a "which providers are covered" heading with no dedicated slot).
  Every heading gets its own titled block with the **full paragraph
  text that follows it in the docx** — never just the heading with no
  body, and never a summarized/merged version that quietly folds two
  docx paragraphs into one. If no existing component slot fits, reuse
  a plain `ContentBox` with a manual `<h2>` + `<p>` rather than
  dropping the section.
- **Reordered sections.** Don't let the *pre-existing* component order
  in `index.astro` (hero → login widget → carousel → reviews → ...)
  dictate where docx content lands. Walk the docx top to bottom and
  place each section's `ContentBox`/etc. in that same order; only
  *then* slot in the non-docx UI widgets (login form, image carousel,
  review cards, wallet/signup blurbs) around the docx content — at the
  very start (before section 1) or the very end (after the last docx
  section), not spliced between two docx sections. If a supporting
  component (provider grid, live-winners feed, RTP/volatility 3-col)
  visually belongs to one specific docx section, place it immediately
  after that section's `ContentBox`, not wherever it happened to sit
  in the old file.

**Heading tags: match what the docx actually uses, everywhere.** If
every section in the docx is marked H2 (no H3 sub-headings), every
section title in the rendered page must be an `<h2>` — not just in the
`ContentBox`/`ContentBox3Three` markup you write by hand, but also
inside any shared component you call into. Several of this template's
components hardcode a lower heading level for their title prop (e.g. a
"seven-three" image block's `titleright` rendering as `<h3>`, a
provider-grid card name rendering as `<h3>`, a footer column heading
rendering as `<h3>`) — these render on the final page even though
you never typed `<h3>` yourself. Grep every component `index.astro`
touches for `<h[1-6]` and normalize each one to match the docx's
actual heading level before calling the page done; don't stop at
grepping `index.astro`'s own markup. (Only keep a real level
*hierarchy* — e.g. H1 page title → H2 section → H3 sub-item — if the
docx itself has that nested structure; if it's flat H1+H2 only,
flatten the page to match.)

**The one sanctioned exception to "flatten everything to H2": a docx
section with a short bullet-style sub-list under it.** When one docx
H2 section's body isn't just a paragraph but 2-4 short sub-points
(each with its own short label, e.g. "feature A / feature B / feature
C" under one "features" heading), don't hand-roll a repeated
icon-card `<div>` block with its own `<h2>` per point — that both
breaks the one-H2-per-docx-heading rule and duplicates markup. Use
`src/components/FeatureHighlights.astro`: pass an `items` prop
(`{ icon, title, description, accent?: "gold" | "blue" }[]`), and it
renders each point's `title` as an `<h3>` — the section's own H2
stays the only H2, the sub-points become real H3 children under it.
This is the only place a docx-driven page should have an `<h3>` at
all; if you find yourself wanting more than one heading level below a
section for the same content, that's a sign to reconsider the mapping,
not to add another exception. Wire `FeatureHighlights` into
`index.astro` the same way as any other family component (import it,
pass the docx's sub-points as `items`) whenever a docx section fits
this shape — don't reinvent the icon-card markup inline again.

**Don't leave HTML comments (`<!-- … -->`) in `index.astro`, any page,
or any component that renders on the page.** Astro does *not* strip
`<!-- -->` comments — they ship verbatim into the built HTML, so
section-label breadcrumbs like `<!-- H1: … -->` / `<!-- H2: ทางเข้า … -->`
leak the docx outline (and the old brand name) into production output.
Use the numbered docx heading checklist and the `as="h2"`/`title=` props
themselves as your in-editor markers instead of comment labels; the
semantic tags already say what each block is. This applies to
JS/frontmatter comments only in the sense that those *are* stripped —
the hazard is specifically the HTML-comment syntax in the template body.

**This isn't only about markup you write fresh — the shared components
already carry old `<!-- … -->` labels** (decorative-layer notes like
`<!-- แสงพื้นหลัง -->`, `<!-- Section Header -->`, column markers), and
every one rendered on the page ships to output. When you do the Phase 3
full-file retheme of a component, strip its HTML comments in the same
pass. Scope this to the components the live page actually renders, built
*recursively* (an import of an import — e.g. `LoginRtpSection` →
`ContentBoxTwo` — still renders), and to the active navbar/footer that
`MainLayout.astro` points at (grep its `Navbar*`/`Footer*` imports) —
**not** the inventory siblings that aren't wired in. Find them with
`grep -rn '<!--' src/components src/layouts` then filter to the rendered
set. Verify in Phase 5 with `grep -c '<!--' dist/index.html` (expect 0).
Applied on 2026-07-15 for HENGJUD365: cleaned `ContentBox`,
`ContentBoxSevenThree`, `Announcement6`, `ProviderGrid`,
`ReviewCardSumo2` (the 5 rendered components that had comments) and left
`Navbar`/`Footer`/`NavbarStyle*`/`LatestWinnersPremium`/old
`ReviewCardSumo` untouched as inventory.

## Phase 3 — Retheme every component index.astro touches

Identify the old brand's dominant Tailwind color family (grep the
component tree for a repeated hue like `red-` or `rose-`) and the old
brand name string. For every component actually rendered from
`index.astro` (plus the shared layout chrome — `MainLayout.astro`, the
active `Navbar*`/`Footer*`/`Navfoot.astro`), do a full-file `Write`
rewrite (cleaner than dozens of tiny edits) that:
- swaps every occurrence of the old hue family to the new palette's
  matching Tailwind shade number (`red-600` → `cyan-600`, `red-950` →
  `blue-950`, etc.) and matching `rgba(...)` glow values
- leaves unrelated semantic colors alone (LINE green `#00B900`, green
  "live"/success indicators, real bank brand colors) — only the old
  brand's *identity* color should move
- replaces the old brand name in visible text, `alt=`, and any
  hardcoded fallback text (logo fallback headings, footer copyright)

Also grep the whole `src/` tree for the old brand name after this pass.
Hits inside **inventory components** that `index.astro` doesn't render
(unused `Navbar*`/`Footer*`/`Announcement*`/`Faq*` siblings, etc.) are
expected drift — leave them. But hits inside the **other real pages**
(`src/pages/*.astro`) are **in scope and must be fixed in the same
rebrand — see the Phase 4.5 sweep below.** Don't defer them as "a
separate ask"; a half-rebranded site where `/promotion` or `/login`
still shows the previous brand is a bug the user will bounce back.

## Phase 4.5 — Rebrand EVERY other page, not just `index.astro`

`index.astro` is the biggest page but it is **not** the only one. Once
its edits are done, sweep **every** `src/pages/*.astro` and bring each
onto the new brand — this is mandatory, not optional. (Don't build
between finishing `index.astro` and starting this sweep; the single
Phase 5 build covers all pages at once.) For each page:

1. **Brand name** in `<title>`, `description`, `<h1>`/`ContentBox`
   titles, schema.org `name`/`url`, `alt=` text, and any hardcoded
   logo/brand-identity string (some standalone pages like `login.astro`/
   `register.astro` are full custom HTML with a `.brand-identity` div and
   their own `<style>` block — they don't use `MainLayout`, so they need
   the brand + hue swap done inline, not inherited).
2. **Hue swap** to the new palette — and note the standalone pages often
   theme via **raw hex / `rgba()` in a `<style>` block** (e.g. a CSS var
   misnamed `--brand-red: #2563eb` that's actually the old blue), which a
   tailwind-class grep (`blue-[0-9]`) misses. Grep each page for the old
   brand's hex and `rgba()` glow values too, not just utility classes.
3. **Chrome consistency — make every page's `Announcement*`/navbar/footer
   match `index.astro`.** Pages that share `MainLayout` inherit the
   navbar/footer/hero automatically (you already repointed those in
   Phase 3), but each page imports its **own `Announcement*`** in its
   frontmatter — grep `src/pages/*.astro` for `Announcement` and switch
   every casino/main page to the **same variant `index.astro` uses**
   (e.g. `Announcement6` → `AnnouncementCyber`), so the ticker style +
   message are uniform sitewide. If `index` passes an explicit `message`
   prop, the other pages calling `<Announcement />` bare will fall back
   to that variant's **default** message — make sure that default (which
   you set in Phase 2/3) is the current brand's copy so bare calls match.
4. **Stale-asset check per page** (Phase 4 applies here too — e.g.
   `promotion.astro` hardcodes `slide1-4` imports; confirm the extensions
   exist).
5. **The one sanctioned exception: intentionally-themed sub-sections.**
   Lottery/`หวย` pages (`แนวทาง.astro`, `ตรวจหวย.astro`) run their own
   `Huay` theme (red/gold) + `AnnouncementHuay` on purpose — do **not**
   force them onto the casino brand's hue or `AnnouncementCyber`. Still
   verify they carry **zero** old-brand-name references; only the theme
   is exempt, not the brand name. Note this decision in the workspec.

**The `tools/rebrand-uploader` "ส่วนที่ 4 — Title/Meta หน้าย่อย" is an
OPTIONAL shortcut, NOT a replacement for this phase.** The uploader can
parse a `SUB-PAGES (Title & Meta Description)` section out of the brand's
`content.docx` — when that section exists, its `[หัวข้อ]` headings use the
exact Thai page names (`[โปรโมชั่น]`/`[ติดต่อเรา]`/`[ทดลองเล่น]`/`[ทางเข้า]`)
with `Title:`/`Meta:` lines, and an operator may have already set those 4
pages' `<MainLayout title/description>` before handing the rebrand to you.
**If the docx has NO such section (the common case so far — GROW268 and
earlier had none), nothing special happens and nothing is blocked: you
still set every page's `<title>`/`description` here exactly as always,
inferring them from the docx's main title/H1/H2 the same way you did for
GROW268.** Either way this full phase runs — the sweep for brand name,
hue, chrome consistency, and stale assets across *every* `src/pages/*.astro`
is mandatory regardless of whether the uploader pre-filled the 4 sub-page
titles. (The uploader anchors only on the `<MainLayout>` tag and leaves
`<ContentBox>` titles alone, so re-setting a title here never conflicts
with what it may have written.)

Verify in Phase 5 by grepping **all** of `dist/` (not just
`dist/index.html`) for the old brand name → must be 0 across every page.

**Components can be nested — don't stop at grepping `index.astro`'s own
JSX.** Some sections get extracted into their own wrapper component
that itself imports and renders another shared component (e.g.
`LoginRtpSection.astro` wraps `ContentBoxTwo.astro` — `index.astro`
only ever sees `<LoginRtpSection />`, never `ContentBoxTwo` directly).
A shallow `grep "<ComponentName" src/pages/index.astro` will miss
`ContentBoxTwo` entirely in that case. Build the "every component
`index.astro` touches" list recursively: for each component
`index.astro` imports, also grep *that file* for further
`import ... from "./..."` components it renders, and repeat, before
doing the hue/brand-name sweep in this phase or the verification pass
in Phase 5.

## Phase 4 — Fix stale asset references (the actual bug class this skill exists for)

The user will almost always call out `SmoothCarousel.astro` and
`promotion.astro` by name — both hardcode `import`s of specific asset
filenames/extensions that predate the new brand's asset drop, e.g.
`slide1.png` when only `slide1.webp` exists now. Grep for the stale
extension across `src/` and fix every hit, not just the two named
files:
```bash
grep -rlE "slide[0-9]\.png|banner[0-9]?\.png" src/
```

**The glob-selection trap:** `MainLayout.astro` (and similar) often
pick a hero/banner image via
`import.meta.glob("../assets/banner*.{png,webp,jpg,jpeg}")` and just
take `Object.keys(...)[0]`. If old `.png` originals are still sitting
in `src/assets` alongside the new `.webp` drop (common — the asset
swap usually keeps same-name old files around), **alphabetical sort
picks the stale file silently** — no build error, just the wrong
image rendering. Verify this by checking the actual rendered `<img
src>` in Phase 5, not just that the build succeeds. Fix by explicitly
preferring `.webp` and/or the specific file the user referenced as
"ref", with the naive alphabetical pick only as a last-resort fallback.

**The `banner1` = hero convention (reconcile the glob pick with it).**
The upload tool (`tools/rebrand-uploader`) and Phase 1/2 fix the hero as
**`banner1`**, with `banner2`, `banner3`, … reserved as article-
illustration images. So when you retheme `MainLayout.astro`, its
preferred-banner pick **must target `banner1`** (`path.endsWith("banner1.")`
across the glob'd extensions, or the user's explicit "ref"), and must
*not* inherit the previous brand's hardcoded banner number. A live file
has shipped hardcoding `banner3.png` as the preferred hero (that was one
brand's specific choice); left as-is, once a new brand also uploads a
`banner3` *article* image, the glob would grab that article image as the
hero. When you rewrite `MainLayout.astro` in Phase 3, repoint the
`preferredBannerPath` line to `banner1` — don't carry the old number
forward. Two halves of this trap now differ in how they're handled:
the **stale-extension** half is largely prevented at source (the uploader
normalizes to one extension per name and deletes same-base siblings), but
the **wrong-number** half is not — it's on you to point the hero pick at
`banner1` every rebrand.

**The OG/Twitter image comes from `slide1` (not a `public/` file).**
`MainLayout.astro` sets the `og:image`/`twitter:image` via the `ImageOg`
prop default. It **must** be `import ogImage from "../assets/slide1.png"`
+ `ImageOg = ogImage.src` — so the social preview always tracks the
current brand, because the uploader overwrites `src/assets/slide1.png`
every rebrand. Do **not** point it at a `/slide*.webp` (or any bare
`public/` path): the uploader never writes slides to `public/`, so a
hardcoded `public/slideN.webp` is a stale leftover from a previous brand
that silently ships as the wrong preview image. If you find `ImageOg`
pointing at a `public/` path during a rebrand, repoint it to the
`slide1` import.

## Phase 5 — Verify (always do this, it's where bugs surface)

1. `npm run build` — this is the **one** build for the whole rebrand (all
   editing from Phases 2–4.5 is already done), and it must complete with
   0 pages failing. A clean build only proves the code compiles, not that
   content/images are correct. Only build again if a check below turns up
   a bug you then fix.
2. Start `npm run dev`, `curl` the built pages, and grep the rendered
   HTML:
   - old brand name must not appear anywhere in the response body
   - old hue's Tailwind classes must not appear inside any
     `class="..."` attribute (grep separately for `class="[^"]*` vs.
     raw hits — raw hits inside a bundled `<style>` block from an
     out-of-scope component are expected noise, not a bug)
   - every `<img src=.../_image?href=...>` should reference the
     *new* asset filenames — grep for the old ones to make sure the
     Phase 4 glob trap didn't resurface
   - `grep -o 'og:image" content="[^"]*"' dist/index.html` should point
     at a hashed `/_astro/slide1.*` asset (the current brand's slide1),
     **not** a bare `/slide*.webp` — a `public/` path here means the OG
     image is a stale leftover (see the OG note in Phase 4)
   - grep for `undefined`, `NaN`, `[object Object]` as a cheap check
     for broken prop plumbing
   - `grep -c '<!--' dist/index.html` should be 0 — Astro ships HTML
     comments to output, so any `<!-- H2: … -->` section labels left in
     a page leak the docx outline (and often the old brand name) into
     production; remove them at the source (see Phase 2)
   - if any `*FloatingBadge` component is in play, re-check its
     vertical clearance (see the Phase 2 note) with the page's *actual*
     title text at a narrow/mobile width — a long title that wraps to
     2 lines is the trigger, and it won't show up in a desktop-width
     screenshot or in a build log
   - if a FAQ/accordion was wired up, count its item markup to confirm
     all entries rendered
   - **content completeness/order**: extract every `<h1>`/`<h2>`
     (whatever level the docx uses) from the rendered HTML with a
     regex pass, strip tags, and diff that list against the numbered
     docx heading checklist from Phase 2 — same count, same text, same
     top-to-bottom order. A missing heading or a section that comes
     out of order is a real bug, not a nitpick; go back and fix the
     page structure, don't just note it.
   - **heading-tag consistency**: `grep -o "<h3" dist/index.html |
     wc -l` (adjust the level to whatever the docx *doesn't* use) —
     should be 0 unless the docx genuinely has a nested sub-heading
     under those sections. A non-zero count almost always means a
     shared component (provider card, footer column, image-block
     title prop) is still hardcoding the wrong tag — grep the dist
     HTML around each hit to find which component to fix.
3. Stop the dev server when done (best effort — `pkill`/`taskkill`
   often aren't available in this sandbox; a leftover background dev
   server on port 4321 is harmless, don't fight it).

## Phase 6 — Update the workspec

Keep a `workspec.md` at the repo root as a running log of rebrand work:
goal, docx section inventory, file-by-file change list (grouped:
stale-asset fixes named by the user / layout chrome / component
retheme / content rewrite), the glob/asset bug found and how it was
fixed, verification steps actually run, and an explicit "out of scope"
section listing anything left untouched (other pages still on the old
brand, dead leftover asset files not deleted). Append a new dated
section for follow-up asks (e.g. a later single-component redesign)
rather than rewriting history.

**Record each family's variant pick as a before→after line so the
rotation rule (Phase 2) stays auditable.** For this rebrand, write out
which sibling each family moved *from* and *to* — e.g. `Navbar:
NavbarStyle11 → NavbarStyle6`, `Footer: FooterPremiumSumo → FooterCyber`,
`Announcement: Announcement6 → Announcement3`, `LatestWinners:
LatestWinners2 → LatestWinnersPremium`, `ContentBox mix:
FloatingBadge+CyberCut-heavy → Premium+plain-heavy`. The next rebrand
reads this section to know what NOT to reuse; if any family stayed on
the same variant, the line must say so with the reason. Grep the
previous dated entry's picks before choosing this brand's, so you don't
accidentally land on the same sibling two brands running.

## Phase 7 — Follow-up single-component redesign requests

After the initial rebrand, the user routinely comes back with a narrow
ask on one already-themed component: "re design Announcement6 again",
"เปลี่ยน card แบบใหม่" for the review section, "redesign LoginRtpSection"
(the login-form + RTP-table two-column section extracted out of
`index.astro`), etc. Treat these as a distinct, smaller task — don't
re-run the full rebrand:

1. **Read the file fresh first.** It may have been hand-edited (by the
   user or a formatter) since your last write — don't assume your last
   known version is current.
2. **Scope the change precisely from the user's wording.** "Redesign
   the card" or "เปลี่ยนชื่อ" is about markup/CSS/copy — never touch
   sibling components, the section that renders it, or unrelated
   files unless asked. If the user says "don't change the text/other
   parts anymore" after a prior redesign, that's a hard constraint:
   keep every string in any `const data = [...]` array byte-identical
   (names, roles, review content, numbers) and only rewrite
   markup/CSS. Verify this afterward with a literal grep of the built
   output for a couple of the preserved strings, not just a visual
   diff.
3. **Make the new version visibly different from the last one**, not
   just a recolor — change the actual layout shape (e.g. spotlight +
   list → equal grid with an accent spine, dashed ticket → glowing
   pill capsule). Reusing the exact same div structure with new class
   names isn't a redesign.
4. Reuse the established palette/motifs from Phase 3 (cyan/gold, "Live"
   pulse-dot pattern, porthole/wave/shark visual language) so the new
   version still feels like the same site, not a different brand.
5. Rebuild (`npm run build`) and re-verify per Phase 5 before reporting
   done — a redesign that breaks the build isn't done.
6. Append a dated `## Redesign: <ComponentName>` section to
   `workspec.md` (per Phase 6) describing what changed and why — even
   for a second/third pass on the same component, keep appending, keep
   old entries.
