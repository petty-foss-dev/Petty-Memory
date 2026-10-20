import XCTest

final class BiscottiUITests: MemoryUITestCase {
    private func paired() async throws -> ScratchServer {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if springboard.buttons["Cancel"].exists { springboard.buttons["Cancel"].tap() }
        return try await launchPaired()
    }

    func testMeetingDirectoryFilterAndUnsentFollowUpDraft() async throws {
        _ = try Fixture.required("MEMORY_BISCOTTI_FIXTURE", for: "the fictional Biscotti meeting library")
        let server = try await paired()
        let source = try await eventually("the Cedar site meeting fixture") { try await server.topLevelNote(titled: "Cedar site meeting") }
        let id = try XCTUnwrap(source["id"] as? String)
        try openLibraryTool("OpenMeetings")
        let filter = try require(element("MeetingsFilter"), "Meetings has no filter.")
        filter.tap()
        filter.typeText("Priya")
        let note = element("MeetingOpen_\(id)")
        try reveal(note, "The speaker filter hid the matching meeting.")
        snapshot("Meeting directory and speaker filter")
        let menu = app.buttons["MeetingMenu_\(id)"]
        try reveal(menu, "Meeting actions aren't accessible.")
        menu.tap()
        try require(app.buttons["Find follow-ups"], "Meeting menu lost its follow-up action.").tap()
        let draft = try require(element("ChatDraft"), "The meeting action didn't open AI chat.")
        try waitUntil(draft, NSPredicate(format: "value CONTAINS %@", "Cedar site meeting"), "The meeting draft wasn't seeded.")
        XCTAssertTrue(element("ChatMeetingSeed").exists)
        snapshot("Unsent meeting follow-up draft")
    }

    func testChosenCSVIsPreviewedBeforeImportAndOpensItsSavedNote() async throws {
        _ = try Fixture.required("MEMORY_BISCOTTI_FILE_FIXTURE", for: "the fictional CSV in this simulator's Files storage")
        let title = try Fixture.required("MEMORY_BISCOTTI_FILE_TITLE", for: "the selected meeting import")
        let server = try await paired()
        try openLibraryTool("OpenMeetings")
        try require(app.buttons["MeetingsImport"], "Meetings has no import action.").tap()
        try require(app.buttons["MeetingImportFile"], "Import has no file picker.").tap()
        let file = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Biscotti-phone-fixture")).firstMatch
        if !file.waitForExistence(timeout: 2) {
            let browse = app.buttons["Browse"].firstMatch
            if browse.exists { browse.tap() }
            let local = app.buttons["On My iPhone"].firstMatch
            if local.exists { local.tap() }
        }
        let filename = try require(file, "The dedicated Files fixture isn't visible.")
        // The filename is a separate hit target; activate the document icon just above it.
        filename.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0))
            .withOffset(CGVector(dx: 0, dy: -40)).tap()
        try require(element("MeetingImportCounts"), "Choosing the CSV didn't produce a preview.")
        let before = try await server.topLevelNote(titled: title)
        XCTAssertNil(before, "Picking a file saved a meeting before review.")
        snapshot("Native meeting import preview")
        let apply = app.buttons["MeetingImportApply"]
        try reveal(apply, "The selected meetings cannot be imported.")
        apply.tap()
        try require(element("MeetingImportResult"), "The meeting import didn't finish.")
        let saved = try await eventually("the imported meeting note") { try await server.topLevelNote(titled: title) }
        let id = try XCTUnwrap(saved["id"] as? String)
        let open = app.buttons["MeetingResultOpen_\(id)"]
        try reveal(open, "The saved meeting has no Open note action.")
        open.tap()
        try require(element("ItemMenu"), "The saved meeting didn't open as an ordinary note.")
        snapshot("Imported meeting note")
    }
}
