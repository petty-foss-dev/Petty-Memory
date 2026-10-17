import CryptoKit
import Foundation

// Session generations discard key derivations that finish after locking.
@MainActor
public final class VaultKeyring {
    private var passphrase: String?
    private var keys: [String: SymmetricKey] = [:]
    public private(set) var generation = 0
    private let derive: @Sendable (String, Data) -> SymmetricKey

    public init(derive: @escaping @Sendable (String, Data) -> SymmetricKey = { VaultCrypto.deriveKey(passphrase: $0, salt: $1) }) {
        self.derive = derive
    }

    public var isUnlocked: Bool { passphrase != nil }

    /// Checks `passphrase` against a sealed note when there is one, then keeps it. Returns the generation it unlocked.
    public func unlock(_ passphrase: String, checking sample: (id: String, envelope: SecretEnvelope)?) async throws -> Int {
        let started = generation
        if let sample {
            let key = await derived(passphrase, salt: sample.envelope.salt)
            guard started == generation else { throw CancellationError() }
            do {
                _ = try VaultCrypto.open(sample.envelope, id: sample.id, key: key)
            } catch {
                throw VaultError.wrongPassphrase
            }
            keys[sample.envelope.salt] = key
        }
        self.passphrase = passphrase
        return generation
    }

    public func lock() {
        generation += 1
        passphrase = nil
        keys = [:]
    }

    /// The key for `salt`, derived once per unlock. Throws if the vault is locked or was locked after `generation`.
    public func key(for salt: String, generation: Int) async throws -> SymmetricKey {
        guard generation == self.generation, let passphrase else { throw CancellationError() }
        if let key = keys[salt] { return key }
        let key = await derived(passphrase, salt: salt)
        guard generation == self.generation, self.passphrase != nil else { throw CancellationError() }
        keys[salt] = key
        return key
    }

    /// A new recovery kit and its one-time code for the current passphrase.
    public func recoveryKit(generation: Int) throws -> (kit: VaultRecoveryKit, code: String) {
        guard generation == self.generation, let passphrase else { throw CancellationError() }
        return try VaultRecovery.make(passphrase: passphrase)
    }

    /// 600,000 PBKDF2 rounds take a noticeable moment, so they run off the main actor.
    private func derived(_ passphrase: String, salt: String) async -> SymmetricKey {
        let derive = derive
        return await Task.detached(priority: .userInitiated) { derive(passphrase, Data(base64Encoded: salt) ?? Data()) }.value
    }
}
