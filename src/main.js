import { createApp } from 'vue'
import './style.css'
import './lib/theme.js' // sets data-theme before first paint
import App from './App.vue'
import DocsPage from './components/DocsPage.vue'

// /docs/<slug>             public published docs
// /docs/preview/<colId>    local preview (reads IndexedDB)
const docs = location.pathname.match(/^\/docs\/(preview\/)?([^/]+)\/?$/)

if (docs) createApp(DocsPage, { preview: !!docs[1], id: decodeURIComponent(docs[2]) }).mount('#app')
else createApp(App).mount('#app')
