import { useState, useEffect } from 'react'
import { useCollection, useLiveSync, useConnectionStatus } from 'cf-sync-kit'
import { collectionsConfig } from '../../shared/schema'
import { hc } from 'hono/client'
import type { AppType } from '../server'

const client = hc<AppType>('/')

type Role = 'viewer' | 'editor' | 'admin'

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
  const projectId = 'demo-project'
  const syncId = `project:${projectId}`

  useLiveSync(syncId, { party: 'todos', scope: projectId })

  const { data: todos, isLoading, add, update, remove, removeMany, isAdding, isEntitySaving, isRemovingMany, addError, removeManyError } = useCollection<typeof collectionsConfig, 'todos'>('todos', syncId, projectId, { debug: true })
  const [newTitle, setNewTitle] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Role simulation (in a real app, this would come from the API)
  const role: Role = currentUser === 'admin' ? 'admin' : currentUser === 'editor' ? 'editor' : 'viewer'

  const canWrite = role !== 'viewer'
  const canDelete = role === 'admin'
  const canBulkDelete = role === 'admin'

  const handleAdd = () => {
    if (newTitle.trim()) {
      add({ title: newTitle.trim(), scope: projectId }, {
        onSuccess: () => setNewTitle('')
      })
    }
  }

  const handleDeleteSelected = () => {
    if (selectedIds.size > 0) {
      removeMany(Array.from(selectedIds), {
        onSuccess: () => setSelectedIds(new Set())
      })
    }
  }

  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelectedIds(next)
  }

  const selectAll = () => {
    if (selectedIds.size === todos.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(todos.map(t => t.id)))
    }
  }

  return (
    <div className="max-w-2xl mx-auto p-6">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold">Project Todos</h1>
          <p className="text-sm text-gray-500 mt-1">
            Synced in Durable Object: <code className="bg-gray-100 px-1 rounded">{`project:${projectId}`}</code>
          </p>
          <p className="text-sm mt-1">
            Your role: <span className="font-semibold capitalize">{role}</span>
          </p>
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

      <div className="bg-blue-50 border border-blue-200 rounded p-3 mb-6 text-sm">
        <p className="font-medium mb-1">Role permissions:</p>
        <ul className="list-disc list-inside text-gray-600">
          <li><strong>Viewer:</strong> Read-only access</li>
          <li><strong>Editor:</strong> Add and update todos</li>
          <li><strong>Admin:</strong> Full access including delete and bulk operations</li>
        </ul>
      </div>

      {canWrite && (
        <>
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
        </>
      )}

      {canBulkDelete && todos.length > 0 && (
        <div className="flex items-center gap-3 mb-4">
          <button
            onClick={selectAll}
            className="px-3 py-1 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 text-sm"
          >
            {selectedIds.size === todos.length ? 'Deselect All' : 'Select All'}
          </button>
          <button
            onClick={handleDeleteSelected}
            disabled={selectedIds.size === 0 || isRemovingMany}
            className="px-4 py-2 bg-orange-500 text-white rounded hover:bg-orange-600 text-sm disabled:opacity-50"
          >
            {isRemovingMany ? 'Deleting...' : `Delete Selected (${selectedIds.size})`}
          </button>
        </div>
      )}

      {removeManyError && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
          Error: {removeManyError instanceof Error ? removeManyError.message : 'Unknown error'}
        </div>
      )}

      {isLoading ? (
        <p className="text-center py-8 text-gray-500">Loading todos...</p>
      ) : todos.length === 0 ? (
        <p className="text-gray-500 text-center py-8">
          {canWrite ? 'No todos yet. Add one above!' : 'No todos in this project.'}
        </p>
      ) : (
        <ul className="space-y-2">
          {todos
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
            .map((todo) => (
              <li
                key={todo.id}
                className="flex items-center gap-3 p-3 border rounded"
              >
                {canDelete && (
                  <input
                    type="checkbox"
                    checked={selectedIds.has(todo.id)}
                    onChange={() => toggleSelect(todo.id)}
                    className="w-5 h-5"
                  />
                )}
                <input
                  type="checkbox"
                  checked={todo.completed}
                  onChange={() => canWrite && update({ id: todo.id, data: { completed: !todo.completed } })}
                  className="w-5 h-5"
                  disabled={!canWrite || isEntitySaving(todo.id)}
                />
                <span className={`flex-1 ${todo.completed ? 'line-through text-gray-500' : ''}`}>
                  {todo.title}
                </span>
                {canDelete && (
                  <button
                    onClick={() => remove(todo.id)}
                    className="px-3 py-1 bg-red-500 text-white rounded hover:bg-red-600 text-sm"
                    disabled={isEntitySaving(todo.id)}
                  >
                    Delete
                  </button>
                )}
              </li>
            ))}
        </ul>
      )}

      <div className="mt-8 p-4 bg-gray-50 rounded text-sm text-gray-600">
        <p className="font-medium mb-2">Test with different users:</p>
        <div className="flex gap-2">
          <code>user</code> (viewer)
          <code>editor</code> (editor)
          <code>admin</code> (admin)
        </div>
      </div>
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
