# Licensing

## Current status

OpenRampart is currently released under the **[MIT Licence](LICENSE)**. The project owner,
Adam McBride, selected it when the repository was created. Everything in this repository is
available under it today.

> **Decision for the project owner:** whether to keep MIT or move to another licence before
> wider release. This document sets out the trade-offs. It does not make the decision. Until
> the owner decides otherwise, MIT applies.

Changing licence later is easiest while the number of outside contributors is small. Code
already released under MIT stays available under MIT to anyone who received it.

## Why the choice matters for OpenRampart

OpenRampart is self-hosted software for individuals, often people dealing with powerful
institutions. Two kinds of future matter:

1. **Community-run hosting.** Advice charities, advocacy groups and cooperatives may want to
   host it for the people they support, sometimes with their own changes.
2. **Commercial hosting.** A company could offer "OpenRampart as a service", possibly with
   proprietary changes that are never shared back.

The licence decides whether (2) must share its improvements with (1).

## Options

### MIT (current)

Permissive. Anyone may use, modify, host and redistribute it, including in closed-source or
commercial products, provided the copyright notice is kept.

- **For:** simplest; maximum adoption; compatible with almost everything; no barrier for
  organisations with cautious legal teams.
- **Against:**
  - no obligation to share modifications, including security or accessibility fixes made by
    hosted services;
  - no explicit patent grant;
  - a commercial host could build a closed fork that people's records then depend on.

### Apache License 2.0

Permissive like MIT, with an explicit **patent licence** and patent-retaliation clause, plus
clearer terms for contributions and notices.

- **For:**
  - the same freedom as MIT, with better legal clarity for companies and contributors;
  - the patent grant protects users and self-hosters;
  - widely understood.
- **Against:**
  - like MIT, it does not require hosted services to share changes;
  - slightly more paperwork (the NOTICE file and stating changes).

### GNU AGPL v3

Strong copyleft that also covers **network use**. Anyone who runs a modified version as a
service must offer its users the modified source.

- **For:**
  - keeps every hosted variant open, which suits a tool meant to strengthen individuals;
  - a commercial host cannot take improvements private;
  - protects the community-run hosting future.
- **Against:**
  - some organisations will not deploy or contribute to AGPL software;
  - combining it with proprietary code is restricted;
  - contributors and integrators must understand copyleft;
  - dual licensing for commercial users would need a contributor agreement.

### Other possibilities (for completeness)

- **MPL 2.0:** file-level copyleft. Modified files stay open, but it can be combined with
  proprietary code. A middle ground, but it does not cover network use the way AGPL does.
- **Source-available licences** (for example BSL or the Elastic Licence): not open source, and
  probably at odds with OpenRampart's mission and with trust from the people it serves.

## Compatibility of dependencies

The JavaScript runtime dependencies are under permissive licences (MIT, ISC, BSD, 0BSD or
Apache-2.0). The one exception is the image library `sharp`, which ships prebuilt **libvips**
binaries (`@img/sharp-libvips-*`) under **LGPL-3.0-or-later**. They are dynamically linked and
can be replaced, which LGPL permits in combination with code under any of the licences below.
All of this is compatible with MIT, Apache-2.0 or AGPLv3 for OpenRampart itself.

The OCR tools are separate programs, invoked as processes and shipped in the container image
under their own licences:

| Tool        | Licence           |
| ----------- | ----------------- |
| Tesseract   | Apache-2.0        |
| OCRmyPDF    | MPL-2.0           |
| Ghostscript | AGPL-3.0          |
| Poppler     | GPL-2.0 / GPL-3.0 |
| libheif     | LGPL-3.0          |

Distributing the container image means distributing those programs under their own licences,
whatever OpenRampart's own licence is.

To list dependency licences:

```sh
npx license-checker --production --summary
```

## If the licence changes

1. Replace `LICENSE` with the new licence text, and update `package.json` `"license"` and the
   README.
2. For Apache-2.0, add a `NOTICE` file.
3. For AGPLv3, add a visible "Source code" link in the web interface, pointing to the
   running version's source. This meets section 13 for operators who run unmodified copies,
   and modified forks must point it at their own source.
4. Consider a Developer Certificate of Origin (DCO) sign-off, or a contributor licence
   agreement, before accepting significant outside contributions. This is especially relevant
   if dual licensing might ever be wanted.
5. Announce the change, and the version from which it applies, in the release notes.
