import Foundation
import LocalAuthentication
import Security

final class FaceIDVault {
    private let preference = "bingrTrack.faceIDEnabled"
    private let item: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "nl.lrvdlinden.bingrtrack.faceid",
        kSecAttrAccount as String: "bingr-refresh-token"
    ]
    private var authenticatedContext: LAContext?

    var enabled: Bool { UserDefaults.standard.bool(forKey: preference) }

    var available: Bool {
        let context = LAContext()
        return context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
            && context.biometryType == .faceID
    }

    func authenticate(completion: @escaping (LAContext?) -> Void) {
        let context = LAContext()
        context.localizedFallbackTitle = ""
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil),
              context.biometryType == .faceID else {
            completion(nil)
            return
        }
        context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics,
                               localizedReason: "Ontgrendel je Bingr Track-sessie") { success, _ in
            DispatchQueue.main.async { completion(success ? context : nil) }
        }
    }

    func enable(_ token: String, context: LAContext) -> Bool {
        guard !token.isEmpty, let access = SecAccessControlCreateWithFlags(
            nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .biometryCurrentSet, nil
        ), disable() else { return false }
        var attributes = item
        attributes[kSecAttrAccessControl as String] = access
        attributes[kSecValueData as String] = Data(token.utf8)
        guard SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess else { return false }
        authenticatedContext = context
        UserDefaults.standard.set(true, forKey: preference)
        return true
    }

    func read(context: LAContext) -> String? {
        guard enabled else { return nil }
        var query = item
        query[kSecUseAuthenticationContext as String] = context
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data, let token = String(data: data, encoding: .utf8) else { return nil }
        authenticatedContext = context
        return token
    }

    func update(_ token: String) -> Bool {
        guard enabled, !token.isEmpty, let context = authenticatedContext else { return false }
        var query = item
        query[kSecUseAuthenticationContext as String] = context
        let changes = [kSecValueData as String: Data(token.utf8)]
        return SecItemUpdate(query as CFDictionary, changes as CFDictionary) == errSecSuccess
    }

    @discardableResult
    func disable() -> Bool {
        let status = SecItemDelete(item as CFDictionary)
        UserDefaults.standard.removeObject(forKey: preference)
        authenticatedContext = nil
        return status == errSecSuccess || status == errSecItemNotFound
    }
}
