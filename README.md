# Bingr Track

Companion voor iPhone, iPad en Android-telefoons en -tablets. Track leest bestaande Bingr-profielen, voortgang, Mijn lijst en kijkgeschiedenis. De app gebruikt uitsluitend de bestaande inlog- en leesroutes. Titels openen via de bestaande Bingr-web/app-link. Titels in Mijn lijst waarvoor de sync alleen een ID aanbiedt, worden waar mogelijk gekoppeld aan de ontvangen kijkgegevens.

Voor de kalender, kijkgeschiedenis en watchlist van Trakt gebruikt Track optioneel een eigen Trakt OAuth-sessie. Registreer daarvoor een client met de redirect URI `bingrtrack://oauth/trakt`. De app gebruikt Authorization Code met PKCE. Op iPhone en iPad kun je in Profiel Face ID inschakelen om je Bingr-sessie bij een volgende start te herstellen. Android vraagt na een koude start opnieuw om je Bingr-login. Een Trakt-koppeling uit Bingr wordt op het hoofdprofiel gelezen zolang het token geldig is. Een aparte Trakt-koppeling bewaart haar toegangstoken per Bingr-account en profiel in de iOS-sleutelhanger of Android Keystore-opslag. Track leest de kijkgegevens en schrijft expliciete wijzigingen aan duimpjes, Mijn lijst en handmatige collecties naar het geselecteerde Bingr-profiel. Het bestaande protocol schrijft een hele sectie: Track leest vlak vóór opslaan opnieuw en behoudt andere velden, maar dit geeft geen atomische bescherming tegen gelijktijdige writes van andere apparaten.

## Bouwen

De publieke Bingr-configuratie staat ingesteld. GitHub Actions-variabelen `BINGR_SUPABASE_URL` en `BINGR_SUPABASE_PUBLISHABLE_KEY` kunnen die waarden overschrijven. Stel `TRACK_TRAKT_CLIENT_ID` in voor Trakt. De bestaande Bingr-app en Supabase-configuratie krijgen hiervoor geen wijzigingen.

- Apple: installeer XcodeGen, voer `xcodegen generate` uit en open `BingrTrack.xcodeproj`. Vul voor een lokale build `Config.local.xcconfig` met dezelfde waarden als de buildvariabelen of gebruik de geconfigureerde ZIP uit Actions. Kies je Apple Developer Team voor installatie op een echt toestel.
- Android: bouw vanuit `android/` met Gradle 8.13, JDK 17 en Android SDK 35, via `gradle assembleDebug`. De GitHub Actions-workflow levert een installeerbare debug-APK op. Bij lokaal bouwen leest Gradle de drie openbare configuratiewaarden uit de omgeving.

De workflow is handmatig opnieuw te starten na het instellen van de variabelen.

## Gelijke builds

Apple en Android gebruiken hetzelfde versiebestand en dezelfde HTML-, CSS-, JavaScript- en splashbestanden uit `web/`. De CI controleert de inhoud en de versie van beide gebouwde apps voordat ze de downloadbestanden uploadt.

Wanneer er geen eigen Trakt-client-ID is opgegeven, gebruikt Track na het inloggen de Trakt-configuratie die Bingr voor het account beschikbaar stelt. Koppel met een tijdelijke apparaatcode. Track schrijft geen Trakt-tokens naar Bingr. Verhoog bij elke oplevering TRACK_BUILD in TrackVersion.xcconfig met één. Houd TRACK_VERSION op 1.0.0 tot een expliciete versie-upgrade.

De builds gebruiken één PNG-render van de oorspronkelijke SwiftUI-component `BingrLogo`. De Xcode-zip en APK bevatten die asset. Voor een lokale checkout kun je de asset ophalen uit de GitHub Actions-build, of op macOS genereren met `swiftc -parse-as-library tools/RenderBingrWordmark.swift -o /tmp/render-bingr-wordmark && /tmp/render-bingr-wordmark web/bingr-wordmark.png`.
