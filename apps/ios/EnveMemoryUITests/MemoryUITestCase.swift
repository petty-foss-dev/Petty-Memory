import UIKit
import UniformTypeIdentifiers
import XCTest

/// Launches the installed app and makes sure it's paired with the scratch server, through the normal pairing UI.
@MainActor
class MemoryUITestCase: XCTestCase {
    var app: XCUIApplication { XCUIApplication() }
    var timeout: TimeInterval { Fixture.timeout }

    func launchPaired() async throws -> ScratchServer {
        let server = try ScratchServer()
        let me = try await server.whoami()
        guard let clientName = me["name"] as? String else { throw FixtureError("The scratch server's /whoami has no client name.") }
        continueAfterFailure = false
        addUIInterruptionMonitor(withDescription: "Local network or notification permission") { alert in
            let text = ([alert.label] + alert.staticTexts.allElementsBoundByIndex.map(\.label)).joined(separator: " ")
            guard text.localizedCaseInsensitiveContains("local network") || text.localizedCaseInsensitiveContains("notifications"),
                  alert.buttons["Allow"].exists else { return false }
            alert.buttons["Allow"].tap()
            return true
        }
        addTeardownBlock { @MainActor [weak self] in self?.captureFailure() }
        app.launch()
        try pair(with: server, clientName: clientName)
        return server
    }

    // MARK: Pairing

    private func pair(with server: ScratchServer, clientName: String) throws {
        let start = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier IN %@", ["Dock_home", "PairingLinkField"])).firstMatch
        try require(start, "The app showed neither onboarding nor its dock.")
        if element("PairingLinkField").exists {
            try submitPairingLink(server)
            try require(app.buttons["Dock_home"], "The app didn't open its library after pairing.")
            return
        }
        app.buttons["Dock_settings"].tap()
        let status = app.staticTexts["ConnectionStatus"]
        try require(status, "Settings didn't show the connection status.")
        try waitUntil(status, NSPredicate(format: "label != %@", "Checking…"))
        // Same address and client name means the same token; anything else is re-paired with the fixture link.
        let current = status.label == "Connected" && shows(server.address) && shows(clientName)
        if !current {
            app.buttons["Pair again"].tap()
            try submitPairingLink(server)
            try waitUntil(element("PairingLinkField"), NSPredicate(format: "exists == false"))
        }
        try waitUntil(status, NSPredicate(format: "label == %@", "Connected"), "The app isn't connected to the scratch server.")
        app.buttons["Dock_home"].tap()
    }

    /// Use a disposable fixture token; typing is needed when the runner's pasteboard is isolated.
    private func submitPairingLink(_ server: ScratchServer) throws {
        if Fixture.value("MEMORY_UI_TYPE_PAIRING_LINK") == "1" {
            let field = try require(element("PairingLinkField"), "The pairing form has no link field.")
            field.tap()
            app.typeText(server.link)
            app.buttons["Test link"].tap()
            app.swipeUp()
            try require(app.buttons["ConnectButton"], "The typed fixture link did not reach the server.").tap()
            return
        }
        UIPasteboard.general.setItems([[UTType.plainText.identifier: server.link]],
                                      options: [.localOnly: true, .expirationDate: Date.now.addingTimeInterval(60)])
        defer { UIPasteboard.general.items = [] }
        let paste = app.buttons["Paste"]
        try require(paste, "The pairing form has no Paste button.")
        paste.tap()
        let field = element("PairingLinkField")
        try waitUntil(field, NSPredicate(format: "value BEGINSWITH %@", "enve-memory://pair"),
                      "The system Paste action did not populate the pairing field.")
        app.swipeUp()
        let connect = app.buttons["ConnectButton"]
        try require(connect, "The scratch server didn't answer the pairing link. \(app.staticTexts.allElementsBoundByIndex.map(\.label).joined(separator: "; "))")
        connect.tap()
    }

    // MARK: Elements and waits

    /// Text fields with a vertical axis surface as text views, so match the identifier on any element type.
    func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    func shows(_ text: String) -> Bool {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch.exists
    }

    @discardableResult
    func require(_ element: XCUIElement, _ message: String) throws -> XCUIElement {
        guard element.waitForExistence(timeout: timeout) else { throw FixtureError(message) }
        return element
    }

    func waitUntil(_ element: XCUIElement, _ predicate: NSPredicate, _ message: String? = nil) throws {
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        guard XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed else {
            throw FixtureError(message ?? "Timed out waiting for \(element) to match \(predicate).")
        }
    }

    /// A toast covers the navigation bar for a few seconds and takes taps meant for its buttons.
    func waitForToastToClear() throws {
        try waitUntil(element("Toast"), NSPredicate(format: "exists == false"))
    }

    func openLibraryTool(_ identifier: String) throws {
        try require(app.buttons["OpenLibrary"], "Home has no Library button.").tap()
        let tool = element(identifier)
        try reveal(tool, "Library has no \(identifier) destination.")
        tool.tap()
    }

    /// Scrolls the current screen down until the element can be tapped.
    func reveal(_ element: XCUIElement, _ message: String) throws {
        try require(element, message)
        let bounds = app.frame
        for _ in 0..<12 {
            let frame = element.frame
            let dock = self.element("MantelDock")
            let bottom = dock.exists ? dock.frame.minY - 8 : bounds.maxY - 120
            if element.isHittable, frame.minY >= bounds.minY + 125, frame.maxY <= bottom { return }
            let down = frame.minY < bounds.minY + 125
            let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: down ? 0.3 : 0.55))
            let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: down ? 0.55 : 0.3))
            start.press(forDuration: 0.05, thenDragTo: end)
        }
        throw FixtureError(message)
    }

    /// Polls the server, which the app reaches through its outbox, until `probe` answers.
    func eventually<T>(_ what: String, _ probe: () async throws -> T?) async throws -> T {
        let deadline = Date.now.addingTimeInterval(timeout)
        while true {
            if let value = try await probe() { return value }
            guard Date.now < deadline else { throw FixtureError("Timed out waiting for \(what).") }
            try await Task.sleep(for: .milliseconds(500))
        }
    }

    // MARK: Attachments

    func snapshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Never over the pairing form (its field holds the token) or a shown recovery code.
    private func captureFailure() {
        guard let run = testRun, run.failureCount + run.unexpectedExceptionCount > 0, app.state == .runningForeground,
              !element("PairingLinkField").exists, !element("VaultRecoveryCode").exists else { return }
        snapshot("Failure")
    }
}
