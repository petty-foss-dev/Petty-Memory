import XCTest

final class HomeUITests: MemoryUITestCase {
    func testQuickCaptureAndRecentItemJourney() async throws {
        let server = try await launchPaired()
        let composer = try require(element("QuickCaptureField"), "Home has no quick capture field.")
        XCTAssertTrue(app.buttons["OpenAIChat"].exists)
        XCTAssertTrue(app.buttons["OpenLibrary"].exists)
        XCTAssertFalse(element("OpenOutline").exists, "Secondary tools still crowd Home.")
        XCTAssertFalse(element("GettingStarted").exists, "The setup checklist still crowds Home.")
        snapshot("Simplified Home")

        let marker = String(Int.random(in: 10_000_000...99_999_999))
        composer.tap()
        composer.typeText(marker)
        try waitUntil(composer, NSPredicate(format: "value == %@", marker), "The keyboard didn't finish entering the note.")
        let save = try require(app.buttons["QuickCaptureSend"], "Quick capture has no Save button.")
        try waitUntil(save, NSPredicate(format: "enabled == true"))
        save.tap()

        _ = try await eventually("the quick note on the server") {
            try await server.list("/items", [URLQueryItem(name: "limit", value: "50")])
                .first { $0["body"] as? String == marker }
        }
        try waitForToastToClear()
        let recent = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", marker)).firstMatch
        try reveal(recent, "The captured note didn't appear in Recent.")
        recent.tap()
        try require(element("ItemMenu"), "Tapping a recent note didn't open its detail.")
        app.buttons["Dock_home"].tap()

        try require(app.buttons["QuickCaptureMenu"], "Home has no capture menu.").tap()
        for name in ["New note", "New link", "New task", "New image"] {
            XCTAssertTrue(app.buttons[name].exists, "The capture menu lost \(name).")
        }
        snapshot("Capture menu")
        app.buttons["New note"].tap()
        try require(element("CaptureBody"), "New note didn't open the note editor.")
        app.buttons["Cancel"].tap()
    }

    func testLibraryKeepsSecondaryToolsAccessible() async throws {
        _ = try await launchPaired()
        try openLibraryTool("OpenOutline")
        try require(element("OutlineComposer"), "Library's Outline action didn't open the outline.")
        app.buttons["Dock_home"].tap()
        try require(app.buttons["OpenLibrary"], "Home has no Library button.").tap()

        for identifier in ["OpenReview", "OpenSavedViews", "OpenTemplates", "OpenKnowledge", "OpenSavedChats", "OpenVault"] {
            try require(element(identifier), "Library lost \(identifier).")
        }
        snapshot("Library tools")
        app.buttons["Dock_home"].tap()
        try require(app.buttons["OpenAIChat"], "Home lost its direct AI chat action.").tap()
        try require(element("ChatDraft"), "The AI action didn't open chat.")
        snapshot("AI chat from Home")
    }
}
