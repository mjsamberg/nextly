// Drag and drop, driven the way a person would (TaskDrag.swift). Run with:
//
//   xcodebuild test -project NextlyNative.xcodeproj -scheme Nextly \
//     -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)'
//
// Not yet seen passing: the owner's Mac can't run a simulator with UI tests
// (CLAUDE.md, Lessons learned), and the drags were checked by hand in the
// Mac app instead. Run them on a machine with more room before relying on them.
//
// The app starts with -NextlyUITests: a throwaway database with made-up
// tasks (AppModel.seedForUITests) and no sync.

import XCTest

final class DragDropUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-NextlyUITests"]
        app.launch()
    }

    /// The titles of the Next list's rows, top to bottom.
    private func nextTitles() -> [String] {
        let titles = ["Next one", "Next two", "Next three"]
        return titles
            .compactMap { t -> (String, CGFloat)? in
                let e = app.staticTexts[t]
                return e.exists ? (t, e.frame.minY) : nil
            }
            .sorted { $0.1 < $1.1 }
            .map(\.0)
    }

    private func drag(_ from: XCUIElement, to: XCUIElement) {
        from.press(forDuration: 1.0, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0.6)
    }

    func testReorderNext() {
        XCTAssertTrue(app.staticTexts["Next three"].waitForExistence(timeout: 60))
        XCTAssertEqual(nextTitles(), ["Next one", "Next two", "Next three"])
        // Dropped on "Next one": lands just before it.
        drag(app.staticTexts["Next three"], to: app.staticTexts["Next one"])
        let moved = expectation(for: NSPredicate { _, _ in self.nextTitles() == ["Next three", "Next one", "Next two"] }, evaluatedWith: nil)
        wait(for: [moved], timeout: 30)
    }

    func testDropOnSidebarListAndProject() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "The sidebar sits beside the list only on iPad.")
        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(app.staticTexts["Next two"].waitForExistence(timeout: 60))

        // Onto Today: it leaves Next.
        drag(app.staticTexts["Next two"], to: app.staticTexts["Today"].firstMatch)
        XCTAssertTrue(app.staticTexts["Next two"].waitForNonExistence(timeout: 30))

        // Onto the project: it moves there (and keeps its flag, so it stays in Next).
        drag(app.staticTexts["Next one"], to: app.staticTexts["Field trip"].firstMatch)
        app.staticTexts["Field trip"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Next one"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.staticTexts["Already in the trip"].exists)

        // And the task flagged Today is in Today.
        app.staticTexts["Today"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Next two"].waitForExistence(timeout: 30))
    }
}
