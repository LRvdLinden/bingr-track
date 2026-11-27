import Foundation
import Security

enum TraktSessionVault {
    static func handle(action: String, scope: String, token: String?) -> Any {
        guard scope.range(of: "^[a-zA-Z0-9_-]{1,64}[.][a-zA-Z0-9_-]{1,64}$", options: .regularExpression) != nil else {
            return NSNull()
        }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "nl.lrvdlinden.bingrtrack.trakt",
            kSecAttrAccount as String: scope
        ]
        switch action {
        case "readTraktSession":
            var read = query
            read[kSecReturnData as String] = true
            read[kSecMatchLimit as String] = kSecMatchLimitOne
            var item: CFTypeRef?
            guard SecItemCopyMatching(read as CFDictionary, &item) == errSecSuccess,
                  let bytes = item as? Data, let value = String(data: bytes, encoding: .utf8) else { return NSNull() }
            return value
        case "clearTraktSession":
            let status = SecItemDelete(query as CFDictionary)
            return status == errSecSuccess || status == errSecItemNotFound
        case "saveTraktSession":
            guard let token, token.utf8.count <= 65536 else { return false }
            let bytes = Data(token.utf8)
            let updated = SecItemUpdate(query as CFDictionary, [kSecValueData as String: bytes] as CFDictionary)
            if updated == errSecSuccess { return true }
            guard updated == errSecItemNotFound else { return false }
            var add = query
            add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            add[kSecValueData as String] = bytes
            return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
        default:
            return NSNull()
        }
    }
}
