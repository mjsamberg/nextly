// Siri and Shortcuts. Lives in an App Intents extension because the main app
// is a Tauri (Rust + web) app with no Swift code of its own.

import AppIntents
import WidgetKit

@main
struct NextlyIntentsExtension: AppIntentsExtension {}

struct AddTaskIntent: AppIntent {
    static var title: LocalizedStringResource = "Add Task"
    static var description = IntentDescription("Adds a task to Nextly. Today and Next don’t need a date.")

    @Parameter(title: "Task", requestValueDialog: "What’s the task?")
    var taskTitle: String

    @Parameter(title: "List", default: .today)
    var list: NextlyList

    static var parameterSummary: some ParameterSummary {
        Summary("Add \(\.$taskTitle) to \(\.$list)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let outcome = try await NextlyAPI.addTask(title: taskTitle, list: list)
        WidgetCenter.shared.reloadAllTimelines()
        switch outcome {
        case .added:
            return .result(dialog: "Added “\(taskTitle)” to \(list.label).")
        case .savedForLater:
            return .result(dialog: "Saved “\(taskTitle)”. Nextly will add it to \(list.label) the next time it opens.")
        }
    }
}

struct ListTasksIntent: AppIntent {
    static var title: LocalizedStringResource = "Show List"
    static var description = IntentDescription("Reads out what’s In Progress, in Today, or in Next.")

    @Parameter(title: "List", default: .today)
    var list: NextlyList

    static var parameterSummary: some ParameterSummary {
        Summary("Show \(\.$list)")
    }

    func perform() async throws -> some IntentResult & ReturnsValue<[String]> & ProvidesDialog {
        guard NextlyAPI.config != nil else { throw NextlyError.notSetUp }
        let (data, fresh) = await NextlyAPI.lists()
        let tasks: [WidgetTask]
        let total: Int
        switch list {
        case .inProgress: tasks = data.inProgress; total = data.inProgressCount
        case .today: tasks = data.today; total = data.counts.today
        case .next: tasks = data.next; total = data.counts.next
        case .inbox, .someday:
            throw NextlyError.message("Siri can read out In Progress, Today and Next. Open Nextly to see \(list.label).")
        }
        let titles = tasks.map(\.title)
        let stale = fresh ? "" : " (from the last time Nextly synced)"
        if titles.isEmpty {
            return .result(value: [], dialog: "\(list.label) is empty\(stale).")
        }
        let spoken = titles.prefix(5).joined(separator: ", ")
        let more = total > 5 ? ", and \(total - 5) more" : ""
        return .result(value: titles, dialog: "\(list.label) has \(total) task\(total == 1 ? "" : "s")\(stale): \(spoken)\(more).")
    }
}

struct NextlyShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AddTaskIntent(),
            phrases: [
                "Add a task in \(.applicationName)",
                "Add a task to \(\.$list) in \(.applicationName)",
                "New \(.applicationName) task",
            ],
            shortTitle: "Add Task",
            systemImageName: "plus.circle"
        )
        AppShortcut(
            intent: ListTasksIntent(),
            phrases: [
                "What’s on my \(\.$list) list in \(.applicationName)",
                "Show my \(.applicationName) \(\.$list) list",
                "What’s in \(.applicationName) \(\.$list)",
            ],
            shortTitle: "Show List",
            systemImageName: "star"
        )
    }
}
