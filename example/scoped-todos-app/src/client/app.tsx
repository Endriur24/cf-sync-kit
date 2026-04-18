import { useState } from 'react'
import { useCollection, useLiveSync, useConnectionStatus } from 'cf-sync-kit'
import { collectionsConfig } from '../../shared/schema'

const COLORS = ['blue', 'green', 'purple', 'orange', 'pink', 'teal']

const App = () => {
  const { status } = useConnectionStatus()

  useLiveSync()

  const { data: lists, add: addList, remove: removeList } = useCollection<typeof collectionsConfig, 'lists'>('lists')

  const [newListName, setNewListName] = useState('')
  const [activeListId, setActiveListId] = useState<string | null>(null)

  const handleAddList = () => {
    const trimmed = newListName.trim()
    if (!trimmed) return
    addList({ name: trimmed, color: COLORS[lists.length % COLORS.length] }, {
      onSuccess: () => setNewListName('')
    })
  }

  const handleRemoveList = (listId: string) => {
    removeList(listId)
    if (activeListId === listId) setActiveListId(null)
  }

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-3xl font-bold">Scoped Broadcast Demo</h1>
        <ConnectionStatus status={status} />
      </div>

      <p className="text-gray-600 mb-6">
        Each list below uses a different <code className="bg-gray-100 px-1 rounded">scope</code>.
        Changes in one list do NOT trigger live updates in others — even though they share the same WebSocket and Durable Object.
      </p>

      <div className="flex flex-wrap gap-2 mb-6">
        {lists.map(list => (
          <button
            key={list.id}
            onClick={() => setActiveListId(list.id === activeListId ? null : list.id)}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
              activeListId === list.id
                ? `bg-${list.color}-600 text-white`
                : `bg-${list.color}-100 text-${list.color}-700 hover:bg-${list.color}-200`
            }`}
          >
            {list.name}
            <span
              onClick={(e) => { e.stopPropagation(); handleRemoveList(list.id) }}
              className="ml-2 opacity-60 hover:opacity-100 cursor-pointer"
            >
              ×
            </span>
          </button>
        ))}
        <div className="flex items-center gap-1">
          <input
            type="text"
            value={newListName}
            onChange={(e) => setNewListName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddList()}
            placeholder="New list name..."
            className="px-3 py-2 border rounded-full text-sm w-40"
          />
          <button
            onClick={handleAddList}
            className="px-4 py-2 bg-gray-800 text-white rounded-full text-sm hover:bg-gray-700"
          >
            +
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {lists.map(list => (
          <TodoListCard
            key={list.id}
            listId={list.id}
            listName={list.name}
            color={list.color}
            isExpanded={activeListId === list.id}
          />
        ))}
      </div>

      {lists.length === 0 && (
        <p className="text-gray-500 text-center py-8">No lists yet. Add one above!</p>
      )}
    </div>
  )
}

function TodoListCard({ listId, listName, color, isExpanded }: { listId: string; listName: string; color: string; isExpanded: boolean }) {
  const scope = listId
  const { data: todosRaw, isLoading, add, update, remove, isAdding, isEntitySaving } = useCollection<typeof collectionsConfig, 'scopedTodos'>('scopedTodos', undefined, scope)
  const todos = todosRaw.filter((t) => t.scope === scope)

  const [newTitle, setNewTitle] = useState('')

  const handleAdd = () => {
    if (newTitle.trim()) {
      add({ title: newTitle.trim(), scope: listId }, {
        onSuccess: () => setNewTitle('')
      })
    }
  }

  const colorClasses: Record<string, { bg: string; border: string; checkbox: string; badge: string }> = {
    blue: { bg: 'bg-blue-50', border: 'border-blue-200', checkbox: 'accent-blue-500', badge: 'bg-blue-100 text-blue-700' },
    green: { bg: 'bg-green-50', border: 'border-green-200', checkbox: 'accent-green-500', badge: 'bg-green-100 text-green-700' },
    purple: { bg: 'bg-purple-50', border: 'border-purple-200', checkbox: 'accent-purple-500', badge: 'bg-purple-100 text-purple-700' },
    orange: { bg: 'bg-orange-50', border: 'border-orange-200', checkbox: 'accent-orange-500', badge: 'bg-orange-100 text-orange-700' },
    pink: { bg: 'bg-pink-50', border: 'border-pink-200', checkbox: 'accent-pink-500', badge: 'bg-pink-100 text-pink-700' },
    teal: { bg: 'bg-teal-50', border: 'border-teal-200', checkbox: 'accent-teal-500', badge: 'bg-teal-100 text-teal-700' },
  }

  const c = colorClasses[color] || colorClasses.blue

  return (
    <div className={`rounded-lg border ${c.border} ${c.bg} overflow-hidden`}>
      <div className={`px-4 py-3 border-b ${c.border} flex items-center justify-between`}>
        <div className="flex items-center gap-2">
          <h2 className="font-semibold">{listName}</h2>
          <span className={`text-xs px-2 py-0.5 rounded-full ${c.badge}`}>
            scope: {listId}
          </span>
        </div>
        <span className="text-xs text-gray-500">{todos.length} items</span>
      </div>

      <div className="p-3">
        <div className="flex gap-1 mb-3">
          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            placeholder="Add item..."
            className="flex-1 px-3 py-1.5 border rounded text-sm bg-white"
          />
          <button
            onClick={handleAdd}
            disabled={isAdding || !newTitle.trim()}
            className="px-3 py-1.5 bg-gray-800 text-white rounded text-sm hover:bg-gray-700 disabled:opacity-50"
          >
            Add
          </button>
        </div>

        {isLoading ? (
          <p className="text-sm text-gray-500 py-4 text-center">Loading...</p>
        ) : todos.length === 0 ? (
          <p className="text-sm text-gray-400 py-4 text-center">Empty</p>
        ) : (
          <ul className="space-y-1.5 max-h-64 overflow-y-auto">
            {todos
              .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
              .map((todo) => (
                <li key={todo.id} className="flex items-center gap-2 py-1.5">
                  <input
                    type="checkbox"
                    checked={todo.completed}
                    onChange={() => update({ id: todo.id, data: { completed: !todo.completed } })}
                    className={`w-4 h-4 ${c.checkbox}`}
                    disabled={isEntitySaving(todo.id)}
                  />
                  <span className={`flex-1 text-sm ${todo.completed ? 'line-through text-gray-400' : ''}`}>
                    {todo.title}
                  </span>
                  <button
                    onClick={() => remove(todo.id)}
                    className="text-gray-400 hover:text-red-500 text-xs px-1"
                    disabled={isEntitySaving(todo.id)}
                  >
                    ×
                  </button>
                </li>
              ))}
          </ul>
        )}
      </div>

      {isExpanded && (
        <div className="px-4 py-2 bg-gray-100 text-xs text-gray-500 border-t border-gray-200">
          Expanded view — this card shows the scope isolation in action
        </div>
      )}
    </div>
  )
}

function ConnectionStatus({ status }: { status: 'connecting' | 'connected' | 'disconnected' }) {
  const config = {
    connecting: { color: 'bg-yellow-500', text: 'Connecting...' },
    connected: { color: 'bg-green-500', text: 'Connected' },
    disconnected: { color: 'bg-red-500', text: 'Disconnected' },
  }
  const { color, text } = config[status]
  return (
    <div className="flex items-center gap-2 text-sm">
      <div className={`w-2.5 h-2.5 rounded-full ${color} animate-pulse`} />
      <span className="text-gray-600">{text}</span>
    </div>
  )
}

export default App
