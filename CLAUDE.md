# Bingr Track: werkafspraken

- Elke Apple-build van Track staat standaard goed ingesteld, zodat Léon in Xcode niets hoeft aan te passen (`project.yml`):
  - Ondertekenen: `DEVELOPMENT_TEAM: EU3UY476T6`, `CODE_SIGN_STYLE: Automatic` (zelfde team als Bingr).
  - Export compliance: `ITSAppUsesNonExemptEncryption: false` in Info.plist (dus geen "Missing Compliance" in App Store Connect).
  - Naam in Xcode: product/target `BingrTrack` (`PRODUCT_NAME: BingrTrack`); de weergavenaam op het beginscherm blijft `Bingr Track`.
  - Categorie: `LSApplicationCategoryType: public.app-category.entertainment`.
  Controleer dit bij elke build voordat de Xcode-zip wordt geleverd.
- Xcode-zip: workflow *Xcode-project* met een eenmalige sleutel (base64 als invoer `pubkey`), zelf ontsleutelen en de zip aan Léon geven. Het Trakt-id (`TRACK_TRAKT_CLIENT_ID`, repo-variabele) komt via `Config.local.xcconfig` in de zip; controleer dat het erin staat.
- Commitberichten in het Nederlands.
