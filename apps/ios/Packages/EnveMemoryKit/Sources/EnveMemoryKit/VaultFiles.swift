import CryptoKit
import Foundation

/// A secret note's file as it is only ever seen on this device: name, type and bytes, all inside the ciphertext.
public struct VaultFile: Sendable {
    public let filename: String
    public let mimeType: String
    public private(set) var data: Data

    /// Checks what the frame allows: a plain name, a plain MIME type, and 1 byte to 20 MiB of contents.
    public init(filename: String, mimeType: String, data: Data) throws {
        guard VaultFile.isSafeName(filename) else { throw VaultError.unsafeFileName }
        guard !data.isEmpty else { throw VaultError.emptyFile }
        guard data.count <= VaultCrypto.maxFileBytes else { throw VaultError.fileTooLarge }
        self.filename = filename
        self.mimeType = VaultFile.isSafeMIME(mimeType) ? mimeType.lowercased() : "application/octet-stream"
        self.data = data
    }

    /// Overwrites this copy of the contents; called when the vault locks.
    public mutating func erase() {
        data.resetBytes(in: data.startIndex..<data.endIndex)
        data = Data()
    }

    static func isSafeName(_ name: String) -> Bool {
        !name.trimmingCharacters(in: .whitespaces).isEmpty && name.utf16.count <= 255 && name != "." && name != ".."
            && !name.unicodeScalars.contains { $0 == "/" || $0 == "\\" || $0.value < 0x20 || $0.value == 0x7F }
    }

    static func isSafeMIME(_ value: String) -> Bool {
        value.lowercased().wholeMatch(of: /[a-z0-9][a-z0-9!#$&^_.+\-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+\-]{0,126}/) != nil
    }
}

extension VaultCrypto {
    public static let maxFileBytes = 20 * 1024 * 1024
    static let maxFileMetaBytes = 4096
    static let frameMagic = Data("PMVF1".utf8)

    /// Binds a file's ciphertext to its note and attachment, so it can't be swapped onto another.
    public static func fileAAD(itemID: String, attachmentID: String) -> Data {
        Data("petty-memory:file:v1:\(itemID):\(attachmentID)".utf8)
    }

    /// `PMVF1`, a big-endian 32-bit metadata length, `{"filename","mimeType"}` as UTF-8 JSON, then the bytes, sealed with a fresh IV.
    public static func sealFile(_ file: VaultFile, itemID: String, attachmentID: String, key: SymmetricKey, salt: Data) throws -> SecretEnvelope {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let meta = try encoder.encode(FileMeta(filename: file.filename, mimeType: file.mimeType))
        guard meta.count <= maxFileMetaBytes else { throw VaultError.unsafeFileName }
        var length = UInt32(meta.count).bigEndian
        var frame = frameMagic + Data(bytes: &length, count: 4) + meta + file.data
        defer { frame.resetBytes(in: frame.startIndex..<frame.endIndex) }
        return try sealBytes(frame, aad: fileAAD(itemID: itemID, attachmentID: attachmentID), key: key, salt: salt)
    }

    public static func openFile(_ envelope: SecretEnvelope, itemID: String, attachmentID: String, key: SymmetricKey) throws -> VaultFile {
        guard envelope.isPortable else { throw VaultError.legacyEnvelope }
        var frame: Data
        do {
            frame = try openBytes(envelope, aad: fileAAD(itemID: itemID, attachmentID: attachmentID), key: key)
        } catch {
            throw VaultError.damagedFile
        }
        defer { frame.resetBytes(in: frame.startIndex..<frame.endIndex) }
        let bytes = [UInt8](frame.prefix(9))
        guard frame.count >= 9, Data(bytes.prefix(5)) == frameMagic else { throw VaultError.damagedFile }
        let length = Int(bytes[5]) << 24 | Int(bytes[6]) << 16 | Int(bytes[7]) << 8 | Int(bytes[8])
        guard length <= maxFileMetaBytes, 9 + length <= frame.count, frame.count - 9 - length <= maxFileBytes else { throw VaultError.damagedFile }
        let start = frame.startIndex + 9
        guard String(data: frame[start..<start + length], encoding: .utf8) != nil,
              let meta = try? JSONDecoder().decode(FileMeta.self, from: frame[start..<start + length]),
              VaultFile.isSafeMIME(meta.mimeType) else { throw VaultError.damagedFile }
        do {
            return try VaultFile(filename: meta.filename, mimeType: meta.mimeType, data: Data(frame[(start + length)...]))
        } catch VaultError.emptyFile {
            throw VaultError.damagedFile
        }
    }

    private struct FileMeta: Codable {
        let filename: String
        let mimeType: String
    }
}

/// A recovery kit: the vault passphrase sealed with a random key that is shown once as the recovery code.
/// Neither travels to the server; the kit holds no notes, so a library backup is still needed.
public struct VaultRecoveryKit: Codable, Hashable, Sendable {
    public static let kind = "petty-memory-vault-recovery"

    public let v: Int
    public let kind: String
    public let iv: String
    public let tag: String
    public let data: String
}

public enum VaultRecovery {
    static let aad = Data("petty-memory:recovery:v1".utf8)
    static let maxDataChars = 65_536

    /// A new kit for `passphrase` and its code: `pmr1_` and the unpadded base64url of the 32-byte key.
    public static func make(passphrase: String) throws -> (kit: VaultRecoveryKit, code: String) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .withoutEscapingSlashes
        var plain = try encoder.encode(Wrapped(passphrase: passphrase.precomposedStringWithCompatibilityMapping))
        defer { plain.resetBytes(in: plain.startIndex..<plain.endIndex) }
        let key = SymmetricKey(data: VaultCrypto.randomBytes(32))
        let box = try AES.GCM.seal(plain, using: key, nonce: AES.GCM.Nonce(data: VaultCrypto.randomBytes(12)), authenticating: aad)
        let kit = VaultRecoveryKit(v: 1, kind: VaultRecoveryKit.kind, iv: Data(box.nonce).base64EncodedString(),
                                   tag: box.tag.base64EncodedString(), data: box.ciphertext.base64EncodedString())
        return (kit, "pmr1_" + key.withUnsafeBytes { base64URL(Data($0)) })
    }

    /// The kit file as saved for the person to keep.
    public static func file(_ kit: VaultRecoveryKit) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(kit)
    }

    /// The passphrase inside a kit file, checked for shape before any decryption. Only for unlocking; never shown.
    public static func passphrase(fromKit file: Data, code: String) throws -> String {
        guard let kit = try? JSONDecoder().decode(VaultRecoveryKit.self, from: file), kit.v == 1, kit.kind == VaultRecoveryKit.kind,
              let iv = canonical(kit.iv), iv.count == 12, let tag = canonical(kit.tag), tag.count == 16,
              kit.data.count <= maxDataChars, let data = canonical(kit.data), !data.isEmpty else { throw VaultError.notARecoveryKit }
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let encoded = trimmed.wholeMatch(of: /pmr1_([A-Za-z0-9_-]{43})/)?.output.1, let raw = fromBase64URL(String(encoded)),
              raw.count == 32, base64URL(raw) == encoded else { throw VaultError.recoveryCodeShape }
        var plain: Data
        do {
            plain = try AES.GCM.open(AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: data, tag: tag),
                                     using: SymmetricKey(data: raw), authenticating: aad)
        } catch {
            throw VaultError.recoveryCodeMismatch
        }
        defer { plain.resetBytes(in: plain.startIndex..<plain.endIndex) }
        guard let passphrase = try? JSONDecoder().decode(Wrapped.self, from: plain).passphrase, !passphrase.isEmpty else {
            throw VaultError.notARecoveryKit
        }
        return passphrase
    }

    private struct Wrapped: Codable {
        let passphrase: String
    }

    private static func canonical(_ base64: String) -> Data? {
        Data(base64Encoded: base64).flatMap { $0.base64EncodedString() == base64 ? $0 : nil }
    }

    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .trimmingCharacters(in: CharacterSet(charactersIn: "="))
    }

    static func fromBase64URL(_ text: String) -> Data? {
        let base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        return Data(base64Encoded: base64 + String(repeating: "=", count: (4 - base64.count % 4) % 4))
    }
}

public struct AttachmentRemoval: Decodable, Hashable, Sendable {
    public let removed: Bool
}

extension Endpoint {
    /// The body is the envelope itself. Online only, like every vault call; the same id and envelope can be sent again safely.
    public static func putSealedAttachment(itemID: String, attachmentID: String, envelope: SecretEnvelope) throws -> Endpoint {
        Endpoint(method: "PUT", path: "/vault/items/\(segment(itemID))/attachments/\(segment(attachmentID))",
                 headers: ["Content-Type": "application/json"], body: try JSONCoding.makeEncoder().encode(envelope))
    }

    public static func sealedAttachment(itemID: String, attachmentID: String) -> Endpoint {
        get("/vault/items/\(segment(itemID))/attachments/\(segment(attachmentID))")
    }

    /// Recoverable: the note's history keeps the file.
    public static func removeSealedAttachment(itemID: String, attachmentID: String) -> Endpoint {
        Endpoint(method: "DELETE", path: "/vault/items/\(segment(itemID))/attachments/\(segment(attachmentID))")
    }
}

extension Attachment {
    /// Stored ciphertext of a secret note's file; its real name and type are inside.
    public var isSealed: Bool { mimeType == "application/vnd.petty-memory.vault+json" }
}
