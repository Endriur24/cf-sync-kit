import { useState } from 'react'
import { useCollection, useLiveSync, useConnectionStatus } from 'cf-sync-kit'
import { collectionsConfig } from '../../shared/schema'

const COLORS = ['blue', 'green', 'purple', 'orange', 'pink', 'teal']

export default function App() {
  const { status } = useConnectionStatus()
  useLiveSync()

  const { data: lists, add: addList, remove: removeList } = useCollection<typeof collectionsConfig, 'lists'>('lists')
  const [activeListId, setActiveListId] = useState<string | null>(null)
  const [newListName, setNewListName] = useState('')

  const activeList = lists.find((l) => l.id === activeListId)

  const handleAddList = () => {
    if (!newListName.trim()) return
    addList({ name: newListName.trim(), color: COLORS[lists.length % COLORS.length] }, {
      onSuccess: (res) => {
        setNewListName('')
        if (res.data?.id) setActiveListId(res.data.id) // Automatically navigate into new subpage
      }
    })
  }

  return (
    <div className="max-w-xl mx-auto p-6 font-sans">
      <div className="flex items-center justify-between mb-6 pb-4 border-b">
        <h1 className="text-xl font-bold">Scoped Demo (Server-Filtered)</h1>
        <span className="text-xs text-gray-500 font-mono">Status: {status}</span>
      </div>

      {/* Navigation: Subpage View vs Main Lists Overview */}
      {activeListId && activeList ? (
        <ScopedSubpage
          listId={activeList.id}
          listName={activeList.name}
          onBack={() => setActiveListId(null)}
        />
      ) : (
        <div>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
            Select a List (Scope Subpage)
          </h2>

          <div className="space-y-2 mb-6">
            {lists.length === 0 ? (
              <p className="text-sm text-gray-400 py-6 text-center border border-dashed rounded-lg">
                No lists created yet. Add one below!
              </p>
            ) : (
              lists.map((list) => (
                <div
                  key={list.id}
                  onClick={() => setActiveListId(list.id)}
                  className="flex items-center justify-between p-3 border rounded-lg hover:border-blue-500 hover:bg-blue-50/50 cursor-pointer transition-all group"
                >
                  <div>
                    <span className="font-medium text-sm text-gray-800">{list.name}</span>
                    <span className="text-xs text-gray-400 font-mono ml-2">scope: {list.id}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-blue-600 font-medium group-hover:underline">Open Subpage →</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        removeList(list.id)
                      }}
                      className="text-gray-400 hover:text-red-500 text-xs px-1"
                      title="Delete list"
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Create New Scope List */}
          <div className="flex gap-2">
            <input
              type="text"
              value={newListName}
              onChange={(e) => setNewListName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddList()}
              placeholder="Create new list / scope..."
              className="flex-1 px-3 py-1.5 border rounded-lg text-sm"
            />
            <button onClick={handleAddList} className="px-4 py-1.5 bg-gray-800 text-white rounded-lg text-sm font-medium">
              + Create List
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Dedicated Subpage for a single Scope.
 * Fetches ONLY the todos for this scope directly from D1 (GET /default/scopedTodos?scope=listId)
 */
function ScopedSubpage({ listId, listName, onBack }: { listId: string; listName: string; onBack: () => void }) {
  const { data: todos, isLoading, add, update, remove } = useCollection<typeof collectionsConfig, 'scopedTodos'>('scopedTodos', undefined, listId)
  const [title, setTitle] = useState('')

  const handleAdd = () => {
    if (!title.trim()) return
    add({ title: title.trim(), scope: listId }, { onSuccess: () => setTitle('') })
  }

  return (
    <div className="border rounded-xl p-5 bg-white shadow-sm">
      <div className="flex items-center justify-between mb-4 pb-3 border-b">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="text-xs px-2.5 py-1 bg-gray-100 hover:bg-gray-200 rounded text-gray-700 font-medium"
          >
            ← Back
          </button>
          <h2 className="font-bold text-lg">{listName}</h2>
        </div>
        <span className="text-xs bg-emerald-100 text-emerald-800 font-mono px-2 py-0.5 rounded">
          GET ?scope={listId}
        </span>
      </div>

      <div className="flex gap-2 mb-4">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          placeholder={`Add todo to ${listName}...`}
          className="flex-1 px-3 py-1.5 border rounded-lg text-sm"
        />
        <button onClick={handleAdd} className="px-4 py-1.5 bg-blue-600 text-white rounded-lg text-sm font-medium">
          Add
        </button>
      </div>

      {isLoading ? (
        <p className="text-sm text-gray-400 py-6 text-center">Loading scope data from D1...</p>
      ) : todos.length === 0 ? (
        <p className="text-sm text-gray-400 py-6 text-center border border-dashed rounded-lg">
          No todos in this scope yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {todos.map((todo) => (
            <li key={todo.id} className="flex items-center justify-between text-sm py-1.5 border-b border-gray-100">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={todo.completed}
                  onChange={() => update({ id: todo.id, data: { completed: !todo.completed } })}
                  className="rounded text-blue-600"
                />
                <span className={todo.completed ? 'line-through text-gray-400' : 'text-gray-800'}>{todo.title}</span>
              </label>
              <button onClick={() => remove(todo.id)} className="text-gray-400 hover:text-red-500 text-xs">
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
