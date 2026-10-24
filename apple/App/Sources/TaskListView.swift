// One list of tasks: quick add on top, then the list's own layout. Today
// shows In Progress first, groups by project and ends with "Up next"; All
// groups by area and project; Next can be dragged into order (TaskList.tsx).

import NextlyKit
import SwiftUI

struct TaskListView: View {
    @Bindable var model: AppModel
    let list: ListView
    @State private var draft = ""
    @FocusState private var quickFocused: Bool

    var body: some View {
        let v = model.view
        let tasks = Lists.tasksFor(v, list, query: model.query)
        List(selection: Binding(get: { model.selectedTaskId }, set: { model.selectedTaskId = $0 })) {
            header(v, tasks)
            if list != .logbook && list != .search { quickAdd }
            switch list {
            case .all: allBody(v)
            case .today: todayBody(v, tasks)
            case .next: nextBody(tasks)
            default:
                if tasks.isEmpty { empty } else { ForEach(tasks) { row($0) } }
            }
        }
        .listStyle(.plain)
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle(Lists.viewTitle(v, list))
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        #if os(macOS)
        .onDeleteCommand { if let s = model.selectedTaskId { model.remove(s) } }
        #endif
        .onChange(of: model.focusQuickAdd) { quickFocused = true }
    }

    // MARK: - Header and quick add

    @ViewBuilder private func header(_ v: ViewData, _ tasks: [TaskItem]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(Lists.viewTitle(v, list).uppercased())
                .font(Theme.heading(28))
                .foregroundStyle(list == .today ? Theme.plum : .primary)
            Text(subtitle(tasks)).font(Theme.small).foregroundStyle(.secondary)
        }
        .listRowSeparator(.hidden)
        .padding(.top, 4)
    }

    private func subtitle(_ tasks: [TaskItem]) -> String {
        switch list {
        case .today: Date().formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day()) + " · \(tasks.count) open"
        case .next: "\(tasks.count) · drag to reorder"
        case .logbook: "\(tasks.count) done"
        default: "\(tasks.count)"
        }
    }

    private var quickAdd: some View {
        HStack(spacing: 8) {
            Image(systemName: "plus").foregroundStyle(Theme.plum)
            #if os(macOS)
            let hint = "New task…  ⌘N  ·  !t Today  !p In Progress  @mon start  *weekly"
            #else
            let hint = "New task…  !t Today  @mon  *weekly"
            #endif
            TextField(hint, text: $draft)
                .textFieldStyle(.plain)
                .focused($quickFocused)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .onSubmit {
                    // Return on an empty field puts the keyboard away; after
                    // adding a task the field stays ready for the next one.
                    let text = draft.trimmingCharacters(in: .whitespaces)
                    model.quickAdd(text, in: list)
                    draft = ""
                    quickFocused = !text.isEmpty
                }
        }
        .padding(8)
        .background(Theme.mist.opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
        .listRowSeparator(.hidden)
    }

    // MARK: - Layouts

    @ViewBuilder private func todayBody(_ v: ViewData, _ tasks: [TaskItem]) -> some View {
        let doing = Lists.tasksFor(v, .doing)
        let next = Lists.tasksFor(v, .next)
        // Group by project (a subtask goes with its parent's project); no project first.
        let groups = Dictionary(grouping: tasks) { t -> String in
            let pid = t.projectId ?? t.parentId.flatMap { v.task($0)?.projectId }
            return v.project(pid)?.title ?? ""
        }
        let keys = groups.keys.sorted { a, b in a.isEmpty ? true : b.isEmpty ? false : a.localizedCompare(b) == .orderedAscending }

        if !doing.isEmpty {
            Section { ForEach(doing) { row($0, as: .doing) } } header: { sectionHeader("In progress · \(doing.count)", color: Theme.teal) }
        }
        if tasks.isEmpty && doing.isEmpty { empty }
        ForEach(keys, id: \.self) { k in
            Section {
                ForEach(groups[k]!) { row($0, as: .today) }
            } header: {
                if !k.isEmpty { sectionHeader(k) } else if !doing.isEmpty { sectionHeader("Today") }
            }
        }
        if !next.isEmpty {
            Section {
                ForEach(next.prefix(5)) { row($0, as: .next) }
                if next.count > 5 {
                    Button("Show \(next.count - 5) more in Next") { model.go(.next) }
                        .buttonStyle(.borderless)
                        .foregroundStyle(Theme.plum)
                }
            } header: { sectionHeader("Up next · \(next.count)") }
        }
    }

    @ViewBuilder private func allBody(_ v: ViewData) -> some View {
        let groups = Lists.allGrouped(v)
        if groups.isEmpty { empty }
        ForEach(groups, id: \.self) { g in
            Section {
                ForEach(g.projects, id: \.self) { p in
                    if let pid = p.projectId {
                        Button { model.go(.project(pid)) } label: {
                            Label("\(p.title) · \(p.tasks.count)", systemImage: "folder").font(Theme.section)
                        }
                        .buttonStyle(.borderless)
                        .foregroundStyle(.secondary)
                        .help("Open project")
                    }
                    // Rows render as if in the project, so they don't repeat its name.
                    ForEach(p.tasks) { row($0, as: p.projectId.map { .project($0) } ?? .all) }
                }
            } header: {
                Text(g.title).font(Theme.heading(18, relativeTo: .title3)).foregroundStyle(Theme.navy)
            }
        }
    }

    @ViewBuilder private func nextBody(_ tasks: [TaskItem]) -> some View {
        if tasks.isEmpty { empty }
        ForEach(tasks) { row($0, as: .next) }
            .onMove { from, to in
                guard let i = from.first else { return }
                let before = to < tasks.count ? tasks[to].id : nil
                if before != tasks[i].id { model.store.moveInNext(tasks[i].id, before: before) }
            }
    }

    private func sectionHeader(_ text: String, color: Color = .secondary) -> some View {
        Text(text.uppercased()).font(Theme.section).foregroundStyle(color)
    }

    private static let emptyText: [ListView: String] = [
        .inbox: "Nothing in your Inbox. New tasks land here until you give them a flag or a project.",
        .today: "Nothing flagged for today. Pull something up from Next, or add a task above.",
        .doing: "Nothing in progress. Swipe a Today task right, or flag it In Progress, when you start on it.",
        .next: "Next is empty. Flag tasks as Next to line up what comes after Today.",
        .scheduled: "Nothing scheduled. Tasks with a start date, a deadline or a repeat show up here.",
        .someday: "No Someday tasks.",
        .all: "No open tasks anywhere. Add one above, or in any list.",
        .logbook: "Finished tasks show up here.",
        .search: "Type to search task titles and notes.",
    ]

    private var empty: some View {
        Text(Self.emptyText[list] ?? "No open tasks in this project. Add one above.")
            .font(Theme.body(size: 14))
            .foregroundStyle(.secondary)
            .listRowSeparator(.hidden)
            .padding(.vertical, 8)
    }

    // MARK: - Rows

    private func row(_ t: TaskItem, as context: ListView? = nil) -> some View {
        let ctx = context ?? list
        return TaskRow(model: model, t: t, context: ctx)
            .tag(t.id)
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                if !t.done && !t.readOnly && Logic.promote(t.flag) != t.flag {
                    let to = Logic.promote(t.flag)
                    Button { model.store.setFlag(t.id, to) } label: { Label(Self.label(to), systemImage: to == .doing ? "play.fill" : "star.fill") }
                        .tint(to == .doing ? Theme.teal : Theme.gold)
                }
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                if !t.done && !t.readOnly {
                    let to = Logic.defer(t.flag)
                    Button { model.store.setFlag(t.id, to) } label: { Label(Self.label(to), systemImage: "arrow.right") }
                        .tint(Theme.navy)
                }
            }
    }

    static func label(_ f: Flag) -> String {
        switch f {
        case .doing: "In Progress"
        case .today: "Today"
        case .next: "Next"
        case .someday: "Someday"
        case .inbox: "Inbox"
        }
    }
}

/// One task: checkbox, title with its project or parent, and chips.
struct TaskRow: View {
    let model: AppModel
    let t: TaskItem
    let context: ListView

    var body: some View {
        let v = model.view
        let kids = v.children(t.id)
        let blockers = v.blockers(t)
        let parent = t.parentId.flatMap { v.task($0) }
        let project = v.project(t.projectId)
        let files = t.notes.filter { $0.type == .file || $0.type == .image }.count
        let blocked = !blockers.isEmpty && !t.done

        HStack(alignment: .center, spacing: 10) {
            CheckBox(done: t.done, size: 18) { model.store.toggleDone(t.id) }
                .disabled(t.readOnly)
            VStack(alignment: .leading, spacing: 2) {
                Text(t.title.nonEmpty ?? "New task")
                    .foregroundStyle(t.title.isEmpty || t.done || blocked ? .secondary : .primary)
                    .strikethrough(t.done, color: .secondary)
                if let parent {
                    Text(parent.title).font(Theme.small).foregroundStyle(.secondary)
                } else if let project, !isProjectList {
                    Text(project.title).font(Theme.small).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 4)
            chips(kids: kids, blockers: blockers, files: files)
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var isProjectList: Bool { if case .project = context { true } else { false } }
    private var showFlag: Bool { ![.doing, .today, .next, .someday, .inbox].contains(context) }

    @ViewBuilder private func chips(kids: [TaskItem], blockers: [TaskItem], files: Int) -> some View {
        HStack(spacing: 4) {
            if !kids.isEmpty { Chip(text: "\(kids.filter(\.done).count)/\(kids.count)", systemImage: "list.bullet.indent") }
            if t.notes.contains(where: { $0.type == .email }) { Image(systemName: "envelope").imageScale(.small).foregroundStyle(.secondary) }
            if files > 0 { Chip(text: files > 1 ? "\(files)" : "", systemImage: "paperclip") }
            if !blockers.isEmpty && !t.done { Chip(text: "Waiting on \(blockers.count)", systemImage: "lock.fill", color: Theme.plum) }
            if showFlag, let f = t.flag {
                switch f {
                case .doing: Chip(text: "In Progress", systemImage: "play.fill", color: Theme.teal)
                case .today: Chip(text: "Today", systemImage: "star.fill", color: Theme.gold)
                case .next: Chip(text: "Next", color: Theme.navy)
                default: EmptyView()
                }
            }
            if let ext = t.external, ext.source == "iiq" {
                let status = ext.status.map { $0.count > 14 ? String($0.prefix(13)) + "…" : $0 }
                Chip(text: status.map { "IIQ · \($0)" } ?? "IIQ", color: Theme.navy)
                    .help("Incident IQ ticket\(ext.status.map { " · \($0)" } ?? "")")
            }
            if let r = t.repeat { Image(systemName: "repeat").imageScale(.small).foregroundStyle(.secondary).help(Logic.repeatLabel(r)) }
            if let s = t.startOn { Chip(text: Logic.deadlineLabel(s), systemImage: "star", color: Theme.gold).help("Moves into Today on this day") }
            if let d = t.deadline { Chip(text: (t.startOn != nil ? "Due " : "") + Logic.deadlineLabel(d)) }
        }
    }
}

/// The round checkbox used in rows and the detail header.
struct CheckBox: View {
    var done: Bool
    var size: CGFloat = 18
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: done ? "checkmark.circle.fill" : "circle")
                .resizable()
                .frame(width: size, height: size)
                .foregroundStyle(done ? Theme.plum : .secondary)
                #if os(iOS)
                .frame(minWidth: 44, minHeight: 32) // tap target (CLAUDE.md: 44pt on iOS)
                #endif
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(done ? "Mark not done" : "Mark done")
    }
}
