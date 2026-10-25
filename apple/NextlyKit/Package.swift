// swift-tools-version: 5.10
// NextlyKit: the data, rules and sync shared by the native iOS, iPadOS and
// macOS apps. No outside dependencies, like the server. The rules match the
// Windows app's (windows/Nextly.Core); spec/fixtures holds both to the same cases.

import PackageDescription

let package = Package(
    name: "NextlyKit",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "NextlyKit", targets: ["NextlyKit"]),
    ],
    targets: [
        .target(name: "NextlyKit"),
        .testTarget(name: "NextlyKitTests", dependencies: ["NextlyKit"]),
    ]
)
