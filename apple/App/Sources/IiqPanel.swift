// The Incident IQ ticket behind a task: status, link, comments, and what
// Nextly sent (IiqPanel.tsx). Ticket changes go through LocalStore.queueIiq;
// the server checks and sends them (server/iiq.js).

import NextlyKit
import SwiftUI

struct IiqPanel: View {
    let model: AppModel
    let task: TaskItem
    let ext: External
    @State private var comment = ""

    static let stateLabel = ["pending": "Sending…", "done": "Done", "manual": "Needs you", "failed": "Failed"]
    static let typeLabel = ["comment": "Comment", "start": "Start ticket", "resolve": "Resolve ticket"]

    var body: some View {
        let actions = Array(model.view.iiqActions(task.id).prefix(5))
        let needsYou = actions.first { $0.action.state == "manual" || $0.action.state == "failed" }
        Section {
            HStack(spacing: 8) {
                Text("INCIDENT IQ").font(Theme.body(.heavy, size: 10)).tracking(0.8).foregroundStyle(.secondary)
                Text("#\(ext.number.text ?? "?")").font(Theme.body(.bold))
                if let s = ext.status { Chip(text: s, color: ext.closed ? Theme.todayInk : Theme.navy) }
                Spacer()
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(details).font(Theme.small).foregroundStyle(.secondary)
                if let u = ext.url, let url = URL(string: u) {
                    Link("Open in Incident IQ \u{2197}\u{FE0E}", destination: url).font(Theme.small)
                }
            }
            if let a = needsYou?.action, let message = a.message {
                Text(message).font(Theme.small).foregroundStyle(a.state == "failed" ? Theme.danger : Theme.todayInk)
            }
            if !ext.closed {
                VStack(alignment: .trailing, spacing: 6) {
                    TextField("Add an internal comment to the ticket…", text: $comment, axis: .vertical)
                        .lineLimit(2...6)
                        .textFieldStyle(.roundedBorder)
                    Button("Post to Incident IQ") {
                        model.store.queueIiq(task.id, "comment", text: trimmed)
                        comment = ""
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.navy)
                    .disabled(trimmed.isEmpty)
                }
            }
            ForEach(actions) { item in
                let a = item.action
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Chip(text: Self.stateLabel[a.state] ?? a.state, color: stateColor(a.state))
                    Text(line(a)).font(Theme.body(size: 13))
                    Spacer(minLength: 4)
                    Text(parseISO(a.createdAt)?.formatted(.dateTime.month(.abbreviated).day().hour().minute()) ?? "")
                        .font(Theme.small).foregroundStyle(.secondary)
                }
            }
        } footer: {
            Label("Comments are internal. In Progress starts the ticket; finishing the task resolves it.", systemImage: "lock")
                .font(Theme.small)
        }
    }

    private var trimmed: String { comment.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var details: String {
        let submitted = ext.created.flatMap(parseISO).map { "Submitted \($0.formatted(.dateTime.month(.abbreviated).day().year()))" }
        let parts = [submitted, ext.requester.map { "Requested by \($0)" }, ext.location, ext.issue, ext.priority.map { "Priority \($0)" }]
            .compactMap { $0?.nonEmpty }
        return parts.isEmpty ? "Ticket details appear after the next sync." : parts.joined(separator: " · ")
    }

    private func line(_ a: IiqAction) -> String {
        var s = Self.typeLabel[a.type] ?? a.type
        if a.type == "comment", let t = a.text, !t.isEmpty { s += ": “\(t.count > 60 ? t.prefix(60) + "…" : t)”" }
        return s
    }

    private func stateColor(_ state: String) -> Color {
        switch state {
        case "done": Theme.teal
        case "manual": Theme.todayInk
        case "failed": Theme.danger
        default: .secondary
        }
    }
}

/// An ISO 8601 date or time, with or without fractional seconds.
func parseISO(_ s: String) -> Date? {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: s) { return d }
    f.formatOptions = [.withInternetDateTime]
    if let d = f.date(from: s) { return d }
    f.formatOptions = [.withFullDate]
    return f.date(from: s)
}
