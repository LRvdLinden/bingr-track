import AppKit
import SwiftUI

// Bingr's iOS wordmark from Shared/UI/Theme.swift.
private enum Theme {
    static let red = Color(red: 229.0 / 255, green: 9.0 / 255, blue: 20.0 / 255)
}

struct BingrLogo: View {
    var size: CGFloat = 34
    var body: some View {
        VStack(alignment: .center, spacing: size * 0.1) {
            Text("BINGR")
                .font(.system(size: size, weight: .heavy, design: .rounded))
                .kerning(size * 0.02)
                .foregroundStyle(.white)
            Capsule().fill(Theme.red)
                .frame(height: max(2, size * 0.09))
                .padding(.horizontal, size * 0.04)
        }
        .fixedSize()
        .shadow(color: .black.opacity(0.5), radius: size * 0.15)
        .accessibilityLabel("Bingr")
    }
}

@main
struct RenderBingrWordmark {
    @MainActor
    static func main() throws {
        let output = URL(fileURLWithPath: CommandLine.arguments[1])
        let renderer = ImageRenderer(content: BingrLogo(size: 26).padding(.horizontal, 3).padding(.vertical, 3))
        renderer.scale = 4
        guard let image = renderer.cgImage,
              let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
            throw CocoaError(.fileWriteUnknown)
        }
        try png.write(to: output, options: .atomic)
    }
}
