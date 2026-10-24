// A task's details: title, when (flag, start date, repeat, deadline),
// project, subtasks, what it waits on and blocks, and notes (Detail.tsx).

import NextlyKit
import SwiftUI

struct DetailView: View {
    let model: AppModel
    let task: TaskItem
    @State private var newSub = ""
    @State private var depQuery = ""
    @State private var depError: String?
    @FocusState private var titleFocused: Bool
    @State private var files: NoteAttachments

    init(model: AppModel, task: TaskItem) {
        self.model = model
        self.task = task
        _files = State(initialValue: NoteAttachments(model: model, taskId: task.id))
    }

    private var store: LocalStore { model.store }
    private var t: TaskItem { task }

    var body: some View {
        let v = model.view
        Form {
            if t.readOnly {
                WarnNote(title: "Saved by a newer Nextly.", text: "This task was last changed by a newer version of Nextly, so this one shows it but won’t change it. Update Nextly on this device to edit it.")
                    .listRowInsets(EdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 8))
            }
            titleSection(v)
            if let ext = t.external, ext.source == "iiq" { IiqPanel(model: model, task: t, ext: ext) }
            whenSection(v)
            subtasksSection(v)
            dependsSection(v)
            NotesSection(model: model, task: t, files: files)
            footer
        }
        .formStyle(.grouped)
        .noteAttachments(files)
        .disabled(t.readOnly)
        .navigationTitle(t.title.nonEmpty ?? "New task")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        #if os(macOS)
        .onExitCommand { model.closeDetail() }
        #endif
        .onAppear { if t.title.isEmpty { titleFocused = true } }
    }

    // MARK: - Title

    @ViewBuilder private func titleSection(_ v: ViewData) -> some View {
        Section {
            if let parent = t.parentId.flatMap({ v.task($0) }) {
                Button { model.open(parent.id) } label: {
                    Label("Subtask of \(parent.title.nonEmpty ?? "untitled task")", systemImage: "arrow.up")
                        .font(Theme.small)
                }
                .buttonStyle(.borderless)
            }
            HStack(alignment: .center, spacing: 10) {
                CheckBox(done: t.done, size: 24) { store.toggleDone(t.id) }
                TextField("New task", text: Binding(
                    get: { t.title },
                    set: { new in store.updateTask(t.id) { $0.title = new.replacingOccurrences(of: "\n", with: " ") } }
                ), axis: .vertical)
                .font(Theme.heading(22, relativeTo: .title2))
                .focused($titleFocused)
                .textFieldStyle(.plain)
            }
        }
    }

    // MARK: - When

    @ViewBuilder private func whenSection(_ v: ViewData) -> some View {
        Section {
            Picker("When", selection: Binding(get: { t.flag }, set: { store.setFlag(t.id, $0) })) {
                Text("Inbox").tag(Flag?.some(.inbox))
                Text("▶ In Progress").tag(Flag?.some(.doing))
                Text("★ Today").tag(Flag?.some(.today))
                Text("Next").tag(Flag?.some(.next))
                Text("Someday").tag(Flag?.some(.someday))
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            DateRow(title: "Today on", systemImage: "star", value: t.startOn) { store.setStartOn(t.id, $0) }
            RepeatRow(task: t) { r in store.updateTask(t.id) { $0.repeat = r } }
            DateRow(title: "Deadline", systemImage: "calendar", value: t.deadline) { d in store.updateTask(t.id) { $0.deadline = d } }
            if t.parentId == nil {
                Picker(selection: Binding(get: { t.projectId }, set: { p in store.updateTask(t.id) { $0.projectId = p } })) {
                    Text("None").tag(String?.none)
                    ForEach(v.projects) { p in Text(p.title.nonEmpty ?? "Untitled project").tag(String?.some(p.id)) }
                } label: {
                    Label("Project", systemImage: "folder")
                }
            }
        }
    }

    // MARK: - Subtasks

    @ViewBuilder private func subtasksSection(_ v: ViewData) -> some View {
        let kids = v.children(t.id)
        Section(kids.isEmpty ? "Subtasks" : "Subtasks · \(kids.filter(\.done).count) of \(kids.count)") {
            ForEach(kids) { k in
                HStack {
                    CheckBox(done: k.done, size: 16) { store.toggleDone(k.id) }
                    TextField("Subtask", text: Binding(get: { k.title }, set: { new in store.updateTask(k.id) { $0.title = new } }))
                        .textFieldStyle(.plain)
                        .foregroundStyle(k.done ? .secondary : .primary)
                    if k.flag == .today { Chip(text: "Today", color: Theme.gold) }
                    if k.flag == .next { Chip(text: "Next", color: Theme.navy) }
                    Button { model.open(k.id) } label: { Image(systemName: "chevron.right") }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Open subtask")
                }
            }
            HStack {
                Image(systemName: "plus").foregroundStyle(.secondary)
                TextField("Add subtask", text: $newSub)
                    .textFieldStyle(.plain)
                    .onSubmit {
                        let title = newSub.trimmingCharacters(in: .whitespaces)
                        if !title.isEmpty {
                            store.createTask(["title": .string(title), "parentId": .string(t.id), "flag": nil, "projectId": t.projectId.map(JSONValue.string) ?? nil])
                        }
                        newSub = ""
                    }
            }
        }
    }

    // MARK: - Depends on, blocks

    @ViewBuilder private func dependsSection(_ v: ViewData) -> some View {
        let q = depQuery.trimmingCharacters(in: .whitespaces).lowercased()
        let options = q.isEmpty ? [] : Array(v.tasks.filter { !$0.done && $0.id != t.id && !t.dependsOn.contains($0.id) && $0.title.lowercased().contains(q) }.prefix(6))
        let blocks = v.blocks(t.id)
        Section("Depends on") {
            ForEach(t.dependsOn, id: \.self) { id in
                if let d = v.task(id) {
                    HStack {
                        Button { model.open(id) } label: {
                            Label(d.title.nonEmpty ?? "Untitled task", systemImage: d.done ? "checkmark" : "lock")
                        }
                        .buttonStyle(.borderless)
                        Spacer()
                        Chip(text: d.done ? "Done" : "Open", color: d.done ? .secondary : Theme.plum)
                        Button { store.removeDependency(t.id, id) } label: { Image(systemName: "xmark") }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("Remove dependency")
                    }
                }
            }
            TextField("Add a task this one waits on…", text: $depQuery)
                .onChange(of: depQuery) { depError = nil }
            ForEach(options) { o in
                Button(o.title) {
                    depError = store.addDependency(t.id, o.id)
                    depQuery = ""
                }
                .buttonStyle(.borderless)
            }
            if let depError { Text(depError).font(Theme.small).foregroundStyle(Theme.danger) }
        }
        if !blocks.isEmpty {
            Section("Blocks") {
                ForEach(blocks) { b in
                    let waiting = !v.blockers(b).isEmpty
                    HStack {
                        Button { model.open(b.id) } label: { Label(b.title.nonEmpty ?? "Untitled task", systemImage: "lock") }
                            .buttonStyle(.borderless)
                        Spacer()
                        Chip(text: b.done ? "Done" : waiting ? "Waiting" : "Free", color: b.done ? .secondary : waiting ? Theme.plum : Theme.navy)
                    }
                }
            }
        }
    }

    // MARK: - Footer

    private var footer: some View {
        Section {
            HStack {
                Text(added).font(Theme.small).foregroundStyle(.secondary)
                Spacer()
                Button("Delete", role: .destructive) { model.remove(t.id) }
            }
        }
    }

    private var added: String {
        let parse = { (s: String) in (try? Date(s, strategy: .iso8601)).map { $0.formatted(date: .abbreviated, time: .omitted) } }
        var s = "Added \(parse(t.createdAt) ?? "")"
        if let d = t.doneAt, let done = parse(d) { s += " · Done \(done)" }
        return s
    }
}

/// An optional date: "optional" with an Add button, or a date picker with Clear.
struct DateRow: View {
    var title: String
    var systemImage: String
    var value: String?
    var set: (String?) -> Void

    var body: some View {
        HStack {
            Label(title, systemImage: systemImage)
            Spacer()
            if let value {
                DatePicker(title, selection: Binding(get: { Logic.parseYmd(value) }, set: { set(Logic.ymd($0)) }), displayedComponents: .date)
                    .labelsHidden()
                Text(Logic.deadlineLabel(value)).font(Theme.small).foregroundStyle(.secondary)
                Button("Clear") { set(nil) }.buttonStyle(.borderless)
            } else {
                Text("optional").font(Theme.small).foregroundStyle(.secondary)
                Button("Add") { set(Logic.ymd(Date())) }.buttonStyle(.borderless)
            }
        }
    }
}

/// Repeat picker: common choices, or every N days/weeks/months/years.
struct RepeatRow: View {
    let task: TaskItem
    var set: (Repeat?) -> Void

    enum Preset: String, CaseIterable, Identifiable {
        case none, daily, weekdays, weekly, biweekly, monthly, yearly, custom
        var id: String { rawValue }
        var label: String {
            switch self {
            case .none: "Never"
            case .daily: "Every day"
            case .weekdays: "Every weekday"
            case .weekly: "Every week"
            case .biweekly: "Every 2 weeks"
            case .monthly: "Every month"
            case .yearly: "Every year"
            case .custom: "Custom…"
            }
        }
        var rule: (every: Int, unit: Repeat.Unit, weekdays: [Int]?)? {
            switch self {
            case .daily: (1, .day, nil)
            case .weekdays: (1, .week, [1, 2, 3, 4, 5])
            case .weekly: (1, .week, nil)
            case .biweekly: (2, .week, nil)
            case .monthly: (1, .month, nil)
            case .yearly: (1, .year, nil)
            case .none, .custom: nil
            }
        }
    }

    private var preset: Preset {
        guard let r = task.repeat else { return .none }
        return Preset.allCases.first { p in
            guard let rule = p.rule else { return false }
            return rule.every == r.every && rule.unit == r.unit && (rule.weekdays ?? []) == (r.weekdays ?? [])
        } ?? .custom
    }

    private func make(every: Int, unit: Repeat.Unit, weekdays: [Int]?) -> Repeat {
        var r = task.repeat ?? Repeat(every: 1, unit: .day)
        r.every = min(365, max(1, every))
        r.unit = unit
        r.weekdays = unit == .week && !(weekdays ?? []).isEmpty ? weekdays : nil
        return r
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Picker(selection: Binding(get: { preset }, set: { p in
                switch p {
                case .none: set(nil)
                case .custom: set(make(every: task.repeat?.every ?? 3, unit: task.repeat?.unit ?? .day, weekdays: nil))
                default: if let r = p.rule { set(make(every: r.every, unit: r.unit, weekdays: r.weekdays)) }
                }
            })) {
                ForEach(Preset.allCases) { Text($0.label).tag($0) }
            } label: {
                Label("Repeat", systemImage: "repeat")
            }
            if let r = task.repeat {
                if preset == .custom {
                    HStack {
                        Stepper("Every \(r.every)", value: Binding(get: { r.every }, set: { set(make(every: $0, unit: r.unit, weekdays: nil)) }), in: 1...365)
                        Picker("Unit", selection: Binding(get: { r.unit }, set: { set(make(every: r.every, unit: $0, weekdays: nil)) })) {
                            Text("days").tag(Repeat.Unit.day)
                            Text("weeks").tag(Repeat.Unit.week)
                            Text("months").tag(Repeat.Unit.month)
                            Text("years").tag(Repeat.Unit.year)
                        }
                        .labelsHidden()
                        .fixedSize()
                    }
                }
                Picker("Count from", selection: Binding(get: { r.from }, set: { f in var n = r; n.from = f; set(n) })) {
                    Text("on schedule").tag(Repeat.From.schedule)
                    Text("after I finish it").tag(Repeat.From.completion)
                }
                Text("\(Logic.repeatLabel(r))\(r.from == .completion ? ", counted from when you finish it" : ""). Finishing it files the next one under Scheduled; it moves into Today on its date.")
                    .font(Theme.small)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
