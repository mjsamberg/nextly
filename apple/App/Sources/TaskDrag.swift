// Dragging tasks: onto a list in the sidebar (flags it, as swiping or the
// detail's flag picker would), onto a project (moves it, as the detail's
// project picker would), or within Next to reorder. The same rules as the
// Windows app (windows/Nextly.App/MainWindow.xaml.cs, Droppable).
//
// The drag carries the task's id as a Nextly-only type, so dropping it in
// another app or a text field does nothing.

import CoreTransferable
import NextlyKit
import UniformTypeIdentifiers

extension UTType {
    /// Declared in Info.plist (UTExportedTypeDeclarations).
    static let nextlyTask = UTType(exportedAs: "com.mjsamberg.nextly.task")
}

struct DraggedTask: Codable, Transferable {
    let id: String

    static var transferRepresentation: some TransferRepresentation {
        CodableRepresentation(contentType: .nextlyTask)
    }
}

/// Where a task can be dropped in the sidebar.
enum DropTarget: Equatable {
    case flag(Flag)
    case project(String)

    /// The sidebar lists that take drops: Inbox, In Progress, Today, Next, Someday.
    init?(_ list: ListView) {
        switch list {
        case .inbox: self = .flag(.inbox)
        case .doing: self = .flag(.doing)
        case .today: self = .flag(.today)
        case .next: self = .flag(.next)
        case .someday: self = .flag(.someday)
        case .project(let id): self = .project(id)
        default: return nil
        }
    }
}

extension AppModel {
    /// Tasks that can be dragged at all: not finished, not from a newer Nextly.
    func canDrag(_ t: TaskItem) -> Bool { !t.done && !t.readOnly }

    /// Whether `t` may be dropped on `target`. Incident IQ tickets stay out of
    /// the Inbox and in their own project; subtasks stay with their parent's project.
    func accepts(_ t: TaskItem, _ target: DropTarget) -> Bool {
        guard canDrag(t) else { return false }
        let ticket = t.external?.source == "iiq"
        switch target {
        case .flag(let f): return t.flag != f && !(f == .inbox && ticket)
        case .project(let id): return t.parentId == nil && !ticket && t.projectId != id
        }
    }

    /// Carries out a drop on the sidebar. Returns false (the drag snaps back) if it isn't allowed.
    func drop(_ items: [DraggedTask], on target: DropTarget) -> Bool {
        guard let id = items.first?.id, let t = view.task(id), accepts(t, target) else { return false }
        switch target {
        case .flag(let f): store.setFlag(t.id, f)
        case .project(let pid): store.updateTask(t.id) { $0.projectId = pid }
        }
        return true
    }

    /// A drop within Next: the dragged task goes just before `beforeId` (nil: to the end).
    func dropInNext(_ items: [DraggedTask], before beforeId: String?) -> Bool {
        guard let id = items.first?.id, id != beforeId, let t = view.task(id), canDrag(t), t.flag == .next else { return false }
        store.moveInNext(id, before: beforeId)
        return true
    }
}
