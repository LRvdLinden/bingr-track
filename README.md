# Bingr Track

Companion voor iPhone, iPad en Android-telefoons en -tablets. Track leest bestaande Bingr-profielen, voortgang, Mijn lijst en kijkgeschiedenis. De app gebruikt uitsluitend de bestaande inlog- en leesroutes. Titels openen via de bestaande Bingr-web/app-link. Titels in Mijn lijst waarvoor de sync alleen een ID aanbiedt, worden waar mogelijk gekoppeld aan de ontvangen kijkgegevens.

Voor de kalender, kijkgeschiedenis en watchlist van Trakt gebruikt Track optioneel een eigen Trakt OAuth-sessie. Registreer daarvoor een client met de redirect URI `bingrtrack://oauth/trakt`. De app gebruikt Authorization Code met PKCE. Bingr en Trakt vragen na een koude start opnieuw om inloggen. Track biedt alleen-lezen toegang tot Bingr-kijkgegevens.

## Bouwen

De publieke Bingr-configuratie staat ingesteld. GitHub Actions-variabelen `BINGR_SUPABASE_URL` en `BINGR_SUPABASE_PUBLISHABLE_KEY` kunnen die waarden overschrijven. Stel `TRACK_TRAKT_CLIENT_ID` in voor Trakt. De bestaande Bingr-app en Supabase-configuratie krijgen hiervoor geen wijzigingen.

- Apple: installeer XcodeGen, voer `xcodegen generate` uit en open `BingrTrack.xcodeproj`. Vul voor een lokale build `Config.local.xcconfig` met dezelfde waarden als de buildvariabelen of gebruik de geconfigureerde ZIP uit Actions. Kies je Apple Developer Team voor installatie op een echt toestel.
- Android: bouw vanuit `android/` met Gradle 8.13, JDK 17 en Android SDK 35, via `gradle assembleDebug`. De GitHub Actions-workflow levert een installeerbare debug-APK op. Bij lokaal bouwen leest Gradle de drie openbare configuratiewaarden uit de omgeving.

De workflow is handmatig opnieuw te starten na het instellen van de variabelen.
