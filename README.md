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


## Trakt op de achtergrond

Track werkt Trakt bij zonder knoppenwand. `web/trakt-core.js` is de motor: de Trakt-sessie wordt pas ververst als het token minder dan een uur geldig is of na een 401 (steeds één verversing tegelijk, de nieuwe sessie wordt bewaard vóór gebruik); een mislukte verversing logt nooit uit (bij een geweigerd refresh-token vraagt Profiel alleen om opnieuw te koppelen). Wijzigingen (gezien, watchlist, beoordeling, lijsten) gaan eerst in een blijvende wachtrij met `watched_at`, in de kluis (sleutelhanger / Keystore, niet in WebView-opslag), en worden op de achtergrond verstuurd met uitstel bij netwerkfouten, 429 en 5xx. Het ophalen gebeurt bij start, hervatten, online komen en elke 15 minuten via `/sync/last_activities`. Titels worden alleen op tmdb-, imdb- of trakt-id gekoppeld, nooit op titel alleen. Duimpjes en Mijn lijst in Bingr worden automatisch naar Trakt gespiegeld; in Profiel staat één statusregel. Echte OS-achtergrondtaken zijn er niet: de motor draait zolang de app open is of kort daarna.

Tests: `node --test test/*.test.js` (draait ook in de workflow).

## Pakketten

De repo is openbaar, dus bouwresultaten staan nooit onversleuteld op GitHub. De workflow *Mobile builds* levert alleen `Bingr-Track-Xcode-versleuteld` en `Bingr-Track-Android-versleuteld` als artefact: AES-256 met een willekeurige sleutel, die met de publieke sleutel `tools/track-builds.pub.pem` is ingepakt (`tools/seal_package.sh`). Ontsleutelen kan alleen met de private sleutel (niet in de repo): `tools/open_package.sh <private.pem> <naam>.enc <uitvoer>`. De workflow *Xcode-project* (handmatig, met een eenmalige publieke sleutel) levert het door XcodeGen gemaakte project versleuteld als annotaties, zoals in Bingr.
