import { useState, useEffect } from 'react'
import { useUserCollection, useUserLiveSync, useConnectionStatus } from 'cf-sync-kit'
import { collectionsConfig } from '../../shared/schema'
import { hc } from 'hono/client'
import type { AppType } from '../server'

const client = hc<AppType>('/')

function App() {
  const [currentUser, setCurrentUser] = useState<string | null>(null)

  useEffect(() => {
    client.api.me.$get()
      .then(async (res) => {
        const data = await res.json()
        if (data.authenticated) setCurrentUser(data.username ?? null)
      })
  }, [])

  const handleLogout = () => {
    window.location.href = '/logout';
  }

  if (!currentUser) {
    return <div>Not authenticated</div>
  }

  return <TodoApp currentUser={currentUser} onLogout={handleLogout} />
}

function TodoApp({ currentUser, onLogout }: { currentUser: string; onLogout: () => void }) {
  const { status } = useConnectionStatus()

  useUserLiveSync(currentUser, { party: 'todos' })

  const { data: todos, isLoading, add, update, remove, isAdding, isEntitySaving, addError } = useUserCollection<typeof collectionsConfig, 'todos'>('todos', currentUser)
  const [newTitle, setNewTitle] = useState('')

  const handleAdd = () => {
    if (newTitle.trim()) {
      add({ title: newTitle.trim() }, {
        onSuccess: () => setNewTitle('')
      })
    }
  }

  return (
    <div className="max-w-2xl mx-auto p-6">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold">My Todos</h1>
          <p className="text-sm text-gray-500 mt-1">Isolated in Durable Object: <code className="bg-gray-100 px-1 rounded">{`user:${currentUser}`}</code></p>
        </div>
        <div className="flex items-center gap-4">
          <ConnectionStatus status={status} />
          <button
            onClick={onLogout}
            className="px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600 text-sm"
          >
            Logout
          </button>
        </div>
      </div>

      <div className="flex gap-2 mb-6">
        <input
          type="text"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          placeholder="New todo..."
          className="flex-1 px-4 py-2 border rounded"
        />
        <button
          onClick={handleAdd}
          disabled={isAdding || !newTitle.trim()}
          className="px-6 py-2 bg-green-500 text-white rounded hover:bg-green-600 disabled:opacity-50"
        >
          {isAdding ? 'Saving...' : 'Add'}
        </button>
      </div>

      {addError && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
          Error: {addError instanceof Error ? addError.message : 'Unknown error'}
        </div>
      )}

      {isLoading ? (
        <p className="text-center py-8 text-gray-500">Loading todos...</p>
      ) : todos.length === 0 ? (
        <p className="text-gray-500 text-center py-8">No todos yet. Add one above!</p>
      ) : (
        <ul className="space-y-2">
          {todos
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
            .map((todo) => (
              <li
                key={todo.id}
                className="flex items-center gap-3 p-3 border rounded"
              >
                <input
                  type="checkbox"
                  checked={todo.completed}
                  onChange={() => update({ id: todo.id, data: { completed: !todo.completed } })}
                  className="w-5 h-5"
                  disabled={isEntitySaving(todo.id)}
                />
                <span className={`flex-1 ${todo.completed ? 'line-through text-gray-500' : ''}`}>
                  {todo.title}
                </span>
                <button
                  onClick={() => remove(todo.id)}
                  className="px-3 py-1 bg-red-500 text-white rounded hover:bg-red-600 text-sm"
                  disabled={isEntitySaving(todo.id)}
                >
                  Delete
                </button>
              </li>
            ))}
        </ul>
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
