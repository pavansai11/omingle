import './globals.css'

export const metadata = {
  title: 'HippiChat — Random Video & Voice Chat',
  description: 'Random video and voice chat. Meet strangers worldwide, add friends, and reconnect later on HippiChat.',
  openGraph: {
    title: 'HippiChat — Random Video & Voice Chat',
    description: 'Random video and voice chat with friends, history, and reconnects on HippiChat.',
    type: 'website',
  },
}

export default function RootLayout({ children }) {
  return (
    <html lang="en" className="dark">
      <head>
        <script dangerouslySetInnerHTML={{__html:'window.addEventListener("error",function(e){if(e.error instanceof DOMException&&e.error.name==="DataCloneError"&&e.message&&e.message.includes("PerformanceServerTiming")){e.stopImmediatePropagation();e.preventDefault()}},true);'}} />
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
      </head>
      <body className="bg-gray-950 text-white antialiased min-h-screen">
        {children}
      </body>
    </html>
  )
}
