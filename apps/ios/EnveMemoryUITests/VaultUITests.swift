import XCTest

// Uses only a disposable library and a dedicated simulator's Files storage.
final class VaultUITests: MemoryUITestCase {
    func testUnlockNestedNoteRecoveryKitAndLock() async throws {
        let passphrase = try Fixture.required("MEMORY_VAULT_PASSPHRASE", for: "the vault UI test")
        let parentTitle = Fixture.value("MEMORY_VAULT_PARENT_TITLE") ?? "UI fixture vault parent"
        let childTitle = Fixture.value("MEMORY_VAULT_CHILD_TITLE") ?? "UI fixture vault child"
        let secret = Fixture.value("MEMORY_VAULT_CHILD_SECRET") ?? "UI fixture secret text"
        _ = try await launchPaired()

        try openLibraryTool("OpenVault")
        let passphraseField = try require(element("VaultPassphrase"), "The vault didn't offer to unlock.")
        XCTAssertFalse(shows(parentTitle), "A secret title showed before unlocking.")
        passphraseField.tap()
        app.typeText(passphrase)
        app.buttons["VaultUnlock"].tap()
        try require(app.buttons["VaultLock"], "The fixture passphrase didn't unlock the vault.")

        let parentRow = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", parentTitle)).firstMatch
        try require(parentRow, "“\(parentTitle)” isn't in the unlocked vault.")
        snapshot("Vault unlocked")
        parentRow.tap()
        try require(app.staticTexts[parentTitle], "The parent secret note didn't open.")
        let childRow = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", childTitle)).firstMatch
        try reveal(childRow, "“\(childTitle)” isn't inside “\(parentTitle)”.")
        childRow.tap()
        try require(app.buttons["Inside “\(parentTitle)”"], "The child note doesn't show its secret parent.")
        try require(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", secret)).firstMatch,
                    "The child note's secret text didn't open.")
        snapshot("Nested secret note")

        for _ in 0..<2 { app.navigationBars.buttons.element(boundBy: 0).tap() }
        let makeKit = element("VaultMakeRecoveryKit")
        try reveal(makeKit, "The unlocked vault offers no recovery kit.")
        makeKit.tap()
        // No screenshots while the code is on screen.
        let code = try require(app.staticTexts["VaultRecoveryCode"], "The recovery kit sheet didn't show a code.")
        let shown = try XCTUnwrap(code.value as? String)
        XCTAssertTrue(shown.hasPrefix("p m r 1 _"), "The recovery code doesn't start with pmr1_.")

        app.buttons["VaultSaveRecoveryFile"].tap()
        let filename = try require(app.textFields["DOCPicker.filenameTextField"], "The system save sheet didn't appear.")
        filename.tap()
        app.typeText(" UI-\(UUID().uuidString)")
        let save = try require(app.buttons["DOCPicker.actionButton"], "The system save sheet has no Save action.")
        save.tap()
        try waitUntil(save, NSPredicate(format: "exists == false"), "The recovery file wasn't saved.")
        try require(app.buttons["Saved — save another copy"], "The app didn't confirm saving the kit.")
        try waitUntil(code, NSPredicate(format: "exists == true AND value == %@", shown),
                      "The recovery code didn't survive the system save sheet.")

        app.navigationBars["Recovery kit"].buttons["Done"].tap()
        try waitUntil(app.navigationBars["Recovery kit"], NSPredicate(format: "exists == false"))
        let lock = try require(app.buttons["VaultLock"], "The vault locked after closing the recovery kit.")
        XCTAssertTrue(shows(parentTitle), "Secret titles disappeared while the vault was still unlocked.")
        snapshot("Vault still unlocked after the recovery kit")

        try waitForToastToClear()
        lock.tap()
        try require(element("VaultPassphrase"), "Locking didn't return to the passphrase prompt.")
        for text in [parentTitle, childTitle, secret] {
            XCTAssertFalse(shows(text), "“\(text)” is still on screen after locking.")
        }
        snapshot("Vault locked")
    }
}
