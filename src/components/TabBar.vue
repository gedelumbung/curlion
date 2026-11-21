<!-- Open request tabs (like Postman): click to switch, middle-click or × to close,
     drag to reorder, double-click to keep a preview tab, right-click for more.
     A red dot marks unsaved changes; closing such tabs asks first. -->
<script setup>
import { nextTick, ref, watch } from 'vue'
import { Layers, Loader2, Plus, X } from 'lucide-vue-next'
import { addNewRequest, keepTab, moveTab, openRequest, openTabs, requestCloseTabs, state } from '../store.js'
import { methodColor } from '../lib/ui.js'
import { vTopLayer } from '../lib/topLayer.js'

const SHORT = { DELETE: 'DEL', OPTIONS: 'OPT' }
const strip = ref(null)
const menu = ref(null) // { x, y, index }
const dragFrom = ref(null)
const dropAt = ref(null)

const isActive = (t) => state.active?.requestId === t.requestId

// keep the active tab in view
watch(
  () => state.active?.requestId,
  async (id) => {
    await nextTick()
    strip.value?.querySelector(`[data-tab="${id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  },
)

// vertical mouse wheel scrolls the strip sideways
function onWheel(e) {
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) strip.value.scrollLeft += e.deltaY
}

const closeIds = (ids) => requestCloseTabs(ids)
const idsWhere = (pred) => openTabs.value.filter((_, j) => pred(j)).map((t) => t.tab.requestId)

function onAuxClick(e, t) {
  if (e.button === 1) closeIds([t.requestId])
}

function openMenu(e, index) {
  menu.value = { x: Math.min(e.clientX, window.innerWidth - 220), y: e.clientY, index }
}
const menuItems = [
  { label: 'Close', run: (i) => closeIds(idsWhere((j) => j === i)) },
  { label: 'Close other tabs', run: (i) => closeIds(idsWhere((j) => j !== i)) },
  { label: 'Close tabs to the right', run: (i) => closeIds(idsWhere((j) => j > i)) },
  { label: 'Close all tabs', run: () => closeIds(idsWhere(() => true)) },
]
function runMenu(item) {
  const i = menu.value.index
  menu.value = null
  item.run(i)
}

function onDragStart(e, i) {
  dragFrom.value = i
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('text/plain', String(i))
}
function onDrop(i) {
  if (dragFrom.value !== null) moveTab(dragFrom.value, i)
  dragFrom.value = dropAt.value = null
}
</script>

<template>
  <div class="flex h-9 shrink-0 items-stretch border-b border-zinc-800 bg-zinc-925">
    <div ref="strip" class="tab-strip flex min-w-0 items-stretch overflow-x-auto" @wheel.passive="onWheel">
      <div
        v-for="({ tab, col, req, dirty }, i) in openTabs"
        :key="tab.requestId"
        :data-tab="tab.requestId"
        class="group relative flex max-w-52 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 border-r border-zinc-800 pr-1.5 pl-3 text-xs select-none"
        :class="[
          isActive(tab) ? 'bg-zinc-950 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200',
          dropAt === i && dragFrom !== i ? 'ring-1 ring-orange-500 ring-inset' : '',
        ]"
        :title="`${req ? col.name + ' / ' + req.name : col.name + ' (collection overview)'}${dirty ? ' (unsaved changes)' : ''}${tab.preview ? ' (preview: double-click to keep open)' : ''}`"
        draggable="true"
        @click="openRequest(tab.collectionId, tab.requestId, { preview: tab.preview })"
        @dblclick="keepTab(tab.requestId)"
        @mousedown.middle.prevent
        @auxclick="onAuxClick($event, tab)"
        @contextmenu.prevent="openMenu($event, i)"
        @dragstart="onDragStart($event, i)"
        @dragover.prevent="dropAt = i"
        @dragleave="dropAt === i && (dropAt = null)"
        @drop.prevent="onDrop(i)"
        @dragend="dragFrom = dropAt = null"
      >
        <span v-if="isActive(tab)" class="absolute inset-x-0 top-0 h-0.5 bg-orange-500"></span>
        <span v-if="dirty" class="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-red-500" title="Unsaved changes"></span>
        <template v-if="req">
          <span class="shrink-0 font-mono text-[10px] font-bold" :class="methodColor[req.method]">{{ SHORT[req.method] || req.method }}</span>
          <span class="truncate" :class="{ italic: tab.preview }">{{ req.name }}</span>
          <Loader2 v-if="state.pending[req.id]" :size="12" class="shrink-0 animate-spin text-zinc-500" />
        </template>
        <template v-else>
          <Layers :size="13" class="shrink-0 text-zinc-500" />
          <span class="truncate" :class="{ italic: tab.preview }">{{ col.name }}</span>
        </template>
        <button
          class="ml-auto shrink-0 rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100"
          :class="isActive(tab) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'"
          title="Close tab (middle-click)"
          @click.stop="closeIds([tab.requestId])"
        >
          <X :size="13" />
        </button>
      </div>
    </div>
    <button class="shrink-0 px-2.5 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-100" title="New request" @click="addNewRequest"><Plus :size="15" /></button>

    <Teleport to="body">
      <div v-if="menu" v-top-layer class="top-layer" @click="menu = null" @contextmenu.prevent="menu = null">
        <div class="absolute w-52 rounded-md border border-zinc-700 bg-zinc-800 py-1 text-sm shadow-xl" :style="{ left: menu.x + 'px', top: menu.y + 'px' }" @click.stop>
          <button
            v-for="item in menuItems"
            :key="item.label"
            class="flex w-full items-center px-3 py-1.5 text-left text-zinc-200 hover:bg-zinc-700"
            @click="runMenu(item)"
          >
            {{ item.label }}
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.tab-strip {
  scrollbar-width: none;
}
.tab-strip::-webkit-scrollbar {
  display: none;
}
</style>
