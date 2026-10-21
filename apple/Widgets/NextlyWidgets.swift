// Home Screen, Lock Screen and desktop widgets for Today and Next.
// Each refresh asks the server for fresh lists (falling back to the app's last
// snapshot), so the widget stays current while the app is closed. Tapping a
// circle completes the task right from the widget.

import AppIntents
import SwiftUI
import WidgetKit

// MARK: - Colors (Chatham County Schools palette)

extension Color {
    static let nextlyPlum = Color(red: 122 / 255, green: 60 / 255, blue: 89 / 255)
    static let nextlyNavy = Color(red: 19 / 255, green: 65 / 255, blue: 105 / 255)
    static let nextlyGold = Color(red: 1, green: 182 / 255, blue: 0)
}

// MARK: - Complete from the widget

struct CompleteTaskIntent: AppIntent {
    static var title: LocalizedStringResource = "Complete Task"
    static var isDiscoverable = false

    @Parameter(title: "Task ID")
    var taskId: String

    init() {}
    init(taskId: String) { self.taskId = taskId }

    func perform() async throws -> some IntentResult {
        try await NextlyAPI.complete(taskId: taskId)
        return .result() // WidgetKit reloads the widget after a button intent
    }
}

// MARK: - Timeline

struct ListEntry: TimelineEntry {
    let date: Date
    let data: WidgetData
    let fresh: Bool
    let setUp: Bool
}

struct ListProvider: TimelineProvider {
    func placeholder(in context: Context) -> ListEntry {
        ListEntry(date: .now, data: .sample, fresh: true, setUp: true)
    }

    func getSnapshot(in context: Context, completion: @escaping (ListEntry) -> Void) {
        if context.isPreview {
            completion(placeholder(in: context))
            return
        }
        let cached = AppGroup.read("snapshot.json", as: WidgetData.self)
        completion(ListEntry(date: .now, data: cached ?? .sample, fresh: false, setUp: NextlyAPI.config != nil))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<ListEntry>) -> Void) {
        Task {
            let setUp = NextlyAPI.config != nil
            var data = WidgetData.empty
            var fresh = false
            if setUp { (data, fresh) = await NextlyAPI.lists() }
            let entry = ListEntry(date: .now, data: data, fresh: fresh, setUp: setUp)
            // Not set up yet: check again soon, since the app can't tell us
            // when it has shared its settings. Server unreachable: retry
            // sooner than the normal 15 minutes. (iOS may stretch these.)
            let next = Date.now.addingTimeInterval(!setUp ? 60 : fresh ? 15 * 60 : 5 * 60)
            completion(Timeline(entries: [entry], policy: .after(next)))
        }
    }
}

// MARK: - Views

enum ListKind {
    case today, next

    var title: String { self == .today ? "Today" : "Next" }
    var symbol: String { self == .today ? "star.fill" : "arrow.right" }
    var tint: Color { self == .today ? .nextlyGold : .nextlyNavy }
    var empty: String { self == .today ? "Nothing for today." : "Next is empty." }

    func tasks(_ d: WidgetData) -> [WidgetTask] { self == .today ? d.today : d.next }
    func count(_ d: WidgetData) -> Int { self == .today ? d.counts.today : d.counts.next }
}

struct ListWidgetView: View {
    let entry: ListEntry
    let kind: ListKind
    @Environment(\.widgetFamily) private var family

    private var rows: Int {
        switch family {
        case .systemSmall: return 3
        case .systemMedium: return 4
        case .systemLarge: return 10
        #if os(iOS)
        case .accessoryRectangular: return 2
        #endif
        default: return 3
        }
    }

    var body: some View {
        content.containerBackground(for: .widget) { background }
    }

    @ViewBuilder private var background: some View {
        #if os(iOS)
        if family == .accessoryRectangular || family == .accessoryInline || family == .accessoryCircular {
            Color.clear
        } else {
            Color(.systemBackground)
        }
        #else
        Color(nsColor: .windowBackgroundColor)
        #endif
    }

    @ViewBuilder private var content: some View {
        switch family {
        #if os(iOS)
        case .accessoryInline:
            Label("\(kind.count(entry.data)) \(kind.title)", systemImage: kind.symbol)
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 0) {
                    Image(systemName: kind.symbol).font(.caption)
                    Text("\(kind.count(entry.data))").font(.title3.bold())
                }
            }
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 2) {
                Label("\(kind.title) · \(kind.count(entry.data))", systemImage: kind.symbol).font(.headline)
                ForEach(kind.tasks(entry.data).prefix(rows)) { t in
                    Text(t.title).font(.caption).lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        #endif
        default:
            list
        }
    }

    private var list: some View {
        VStack(alignment: .leading, spacing: family == .systemSmall ? 6 : 8) {
            HStack(spacing: 6) {
                Image(systemName: kind.symbol).foregroundStyle(kind.tint)
                Text(kind.title.uppercased()).font(.system(.headline, design: .rounded).weight(.heavy))
                Spacer(minLength: 0)
                Text("\(kind.count(entry.data))").font(.headline.monospacedDigit()).foregroundStyle(.secondary)
            }
            if !entry.setUp {
                Text("Open Nextly and set up sync to see your tasks here.").font(.caption).foregroundStyle(.secondary)
            } else if kind.tasks(entry.data).isEmpty {
                Text(kind.empty).font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(kind.tasks(entry.data).prefix(rows)) { t in row(t) }
                let extra = kind.count(entry.data) - rows
                if extra > 0 {
                    Text("+\(extra) more").font(.caption2).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
            if family != .systemSmall {
                upNext
            }
            if !entry.fresh && entry.setUp {
                Text("Offline · showing last sync").font(.caption2).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private var upNext: some View {
        if kind == .today, family == .systemLarge, let first = entry.data.next.first {
            Divider()
            HStack(spacing: 6) {
                Image(systemName: "arrow.right").foregroundStyle(Color.nextlyNavy).font(.caption)
                Text("Up next: \(first.title)").font(.caption).lineLimit(1)
            }
        }
    }

    private func row(_ t: WidgetTask) -> some View {
        HStack(spacing: 8) {
            Button(intent: CompleteTaskIntent(taskId: t.id)) {
                Image(systemName: "circle").foregroundStyle(t.blocked ? Color.secondary : kind.tint)
            }
            .buttonStyle(.plain)
            .disabled(t.blocked)
            VStack(alignment: .leading, spacing: 0) {
                Text(t.title)
                    .font(family == .systemSmall ? .caption : .subheadline)
                    .lineLimit(1)
                    .foregroundStyle(t.blocked ? Color.secondary : Color.primary)
                if family != .systemSmall, let project = t.project {
                    Text(project).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            if t.blocked {
                Image(systemName: "lock.fill").font(.caption2).foregroundStyle(Color.nextlyPlum)
            }
        }
    }
}

// MARK: - Widgets

private var families: [WidgetFamily] {
    #if os(iOS)
    return [.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular, .accessoryInline, .accessoryCircular]
    #else
    return [.systemSmall, .systemMedium, .systemLarge]
    #endif
}

struct TodayWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "NextlyToday", provider: ListProvider()) { entry in
            ListWidgetView(entry: entry, kind: .today)
        }
        .configurationDisplayName("Today")
        .description("What you’re doing today. Tap a circle to finish a task.")
        .supportedFamilies(families)
    }
}

struct NextWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "NextlyNext", provider: ListProvider()) { entry in
            ListWidgetView(entry: entry, kind: .next)
        }
        .configurationDisplayName("Next")
        .description("What comes after Today, in your order.")
        .supportedFamilies(families)
    }
}

@main
struct NextlyWidgets: WidgetBundle {
    var body: some Widget {
        TodayWidget()
        NextWidget()
    }
}
