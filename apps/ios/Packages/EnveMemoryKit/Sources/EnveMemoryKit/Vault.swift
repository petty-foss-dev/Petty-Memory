import CommonCrypto
import CryptoKit
import Foundation

/// AES-256-GCM over `{title, body}` with the item id as associated data. Self-describing, so any device can open it.
public struct SecretEnvelope: Codable, Hashable, Sendable {
    public struct KDF: Codable, Hashable, Sendable {
        public let name: String
        public let hash: String?
        public let iterations: Int?
        public let N: Int?
        public let r: Int?
        public let p: Int?

        static let pbkdf2 = KDF(name: "pbkdf2", hash: "sha256", iterations: VaultCrypto.iterations, N: nil, r: nil, p: nil)
    }

    public let v: Int
    public let kdf: KDF
    public let salt: String
    public let iv: String
    public let tag: String
    public let data: String

    /// Sealed on this kind of device. Older desktop notes use scrypt and only open on the computer that holds them.
    public var isPortable: Bool {
        v == 1 && kdf.name == "pbkdf2" && kdf.hash == "sha256" && kdf.iterations == VaultCrypto.iterations
    }
}

public enum VaultError: Error, Hashable, Sendable, LocalizedError {
    case wrongPassphrase
    case legacyEnvelope
    case damaged
    case damagedFile
    case emptyFile
    case fileTooLarge
    case unsafeFileName
    case notARecoveryKit
    case recoveryCodeShape
    case recoveryCodeMismatch

    public var errorDescription: String? {
        switch self {
        case .wrongPassphrase: "That passphrase doesn't open your secret notes."
        case .legacyEnvelope: "This secret note was sealed on your computer in an older format. Open it in Petty Memory on the computer."
        case .damaged: "This secret note can't be opened with the current passphrase, or it was damaged."
        case .damagedFile: "This encrypted file can't be opened with the current passphrase, or it was damaged or made by a newer version."
        case .emptyFile: "That file is empty."
        case .fileTooLarge: "Encrypted files can be at most 20 MB."
        case .unsafeFileName: "Rename the file to a plain name of at most 255 characters, then add it again."
        case .notARecoveryKit: "That isn't a Petty Memory vault recovery kit, or it comes from a newer version."
        case .recoveryCodeShape: "A recovery code is “pmr1_” followed by 43 letters, digits, “-” or “_”. Check that it was copied completely."
        case .recoveryCodeMismatch: "That recovery code doesn't open this recovery kit. Use the code that was saved with this kit."
        }
    }
}

/// End-to-end encryption for secret notes. The passphrase, keys and plaintext never leave this process.
public enum VaultCrypto {
    public static let iterations = 600_000

    public struct Plain: Codable, Hashable, Sendable {
        public var title: String
        public var body: String

        public init(title: String, body: String) {
            self.title = title
            self.body = body
        }
    }

    public static func newSalt() -> Data { randomBytes(16) }

    /// PBKDF2-SHA256 over the NFKC-normalized passphrase, matching the server's normalization.
    public static func deriveKey(passphrase: String, salt: Data) -> SymmetricKey {
        let password = Data(passphrase.precomposedStringWithCompatibilityMapping.utf8)
        var derived = Data(count: 32)
        let status = derived.withUnsafeMutableBytes { out in
            password.withUnsafeBytes { pass in
                salt.withUnsafeBytes { saltBytes in
                    CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2),
                                         pass.baseAddress?.assumingMemoryBound(to: CChar.self), password.count,
                                         saltBytes.baseAddress?.assumingMemoryBound(to: UInt8.self), salt.count,
                                         CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), UInt32(iterations),
                                         out.baseAddress?.assumingMemoryBound(to: UInt8.self), 32)
                }
            }
        }
        precondition(status == kCCSuccess, "PBKDF2 failed")
        return SymmetricKey(data: derived)
    }

    public static func seal(_ plain: Plain, id: String, key: SymmetricKey, salt: Data) throws -> SecretEnvelope {
        try sealBytes(try JSONEncoder().encode(plain), aad: Data(id.utf8), key: key, salt: salt)
    }

    public static func open(_ envelope: SecretEnvelope, id: String, key: SymmetricKey) throws -> Plain {
        guard envelope.isPortable else { throw VaultError.legacyEnvelope }
        do {
            return try JSONDecoder().decode(Plain.self, from: openBytes(envelope, aad: Data(id.utf8), key: key))
        } catch {
            throw VaultError.damaged
        }
    }

    static func sealBytes(_ plain: Data, aad: Data, key: SymmetricKey, salt: Data) throws -> SecretEnvelope {
        let box = try AES.GCM.seal(plain, using: key, nonce: AES.GCM.Nonce(data: randomBytes(12)), authenticating: aad)
        return SecretEnvelope(v: 1, kdf: .pbkdf2, salt: salt.base64EncodedString(), iv: Data(box.nonce).base64EncodedString(),
                              tag: box.tag.base64EncodedString(), data: box.ciphertext.base64EncodedString())
    }

    static func openBytes(_ envelope: SecretEnvelope, aad: Data, key: SymmetricKey) throws -> Data {
        guard let iv = Data(base64Encoded: envelope.iv), iv.count == 12, let tag = Data(base64Encoded: envelope.tag), tag.count == 16,
              let data = Data(base64Encoded: envelope.data) else { throw VaultError.damaged }
        return try AES.GCM.open(AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: data, tag: tag), using: key, authenticating: aad)
    }

    static func randomBytes(_ count: Int) -> Data {
        var generator = SystemRandomNumberGenerator()
        return Data((0..<count).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
    }
}

/// Time-ordered ids, generated here because a secret note's id is sealed into its ciphertext before the server sees it.
public enum UUIDv7 {
    public static func make(now: Date = .now) -> String {
        var bytes = [UInt8](VaultCrypto.randomBytes(16))
        let ms = UInt64(max(0, now.timeIntervalSince1970 * 1000))
        for index in 0..<6 { bytes[index] = UInt8(truncatingIfNeeded: ms >> (8 * UInt64(5 - index))) }
        bytes[6] = (bytes[6] & 0x0F) | 0x70
        bytes[8] = (bytes[8] & 0x3F) | 0x80
        let hex = bytes.map { String(format: "%02x", $0) }.joined()
        let parts = [hex.prefix(8), hex.dropFirst(8).prefix(4), hex.dropFirst(12).prefix(4), hex.dropFirst(16).prefix(4), hex.dropFirst(20)]
        return parts.joined(separator: "-")
    }
}

public struct SealedNoteRequest: Encodable, Sendable {
    public let id: String
    public let envelope: SecretEnvelope
    public let project: String?
    public let tags: [String]?
    /// An ordinary or secret parent; omitted for the top level. A secret parent holds only secret notes.
    public let parentId: String?

    public init(id: String, envelope: SecretEnvelope, project: String? = nil, tags: [String]? = nil, parentId: String? = nil) {
        self.id = id
        self.envelope = envelope
        self.project = project
        self.tags = tags
        self.parentId = parentId
    }
}

private struct EnvelopeBody: Encodable { let envelope: SecretEnvelope }

extension Endpoint {
    /// Secret notes carry only ciphertext; never cached and never queued. `before` is the last note's `pageCursor`.
    public static func secretItems(limit: Int = 50, before: String? = nil) -> Endpoint {
        get("/items", [("secret", "true"), ("limit", String(limit)), ("before", before)])
    }

    /// No idempotency key: these are sent once, directly, and never retried from the outbox.
    public static func createSealedNote(_ request: SealedNoteRequest) throws -> Endpoint {
        Endpoint(method: "POST", path: "/vault/sealed-items", headers: ["Content-Type": "application/json"],
                 body: try JSONCoding.makeEncoder().encode(request))
    }

    public static func updateSealedNote(_ id: String, envelope: SecretEnvelope) throws -> Endpoint {
        Endpoint(method: "PATCH", path: "/vault/sealed-items/\(segment(id))", headers: ["Content-Type": "application/json"],
                 body: try JSONCoding.makeEncoder().encode(EnvelopeBody(envelope: envelope)))
    }

    /// Vault, share-creation, AI, saved-chat, review, insight, import and OCR calls are online-only; the outbox refuses them.
    public var isOnlineOnly: Bool {
        path.hasPrefix("/vault") || path.hasPrefix("/ai/") || (method == "POST" && path == "/shares")
            || ["/conversations", "/review", "/insights/", "/imports/"].contains { path.hasPrefix($0) } || path == "/capture/ocr"
    }
}
