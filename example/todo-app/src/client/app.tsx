import { useState } from 'react'
import { useCollection, useLiveSync, useConnectionStatus } from 'cf-sync-kit'
import { hc } from 'hono/client'
import type { AppType } from '../server'
import { collectionsConfig } from '../../shared/schema'

const client = hc<AppType>('/')

const App = () => {
  useLiveSync()
  const { status } = useConnectionStatus()

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-12">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-4xl font-bold">Live todos</h1>
        <ConnectionStatus status={status} />
      </div>
      <TodosList />
      <NotesList />
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

function TodosList() {
  const { data: todos, isLoading, isError, refetch, add, update, remove,
          isAdding, addError,
          isEntitySaving } = useCollection<typeof collectionsConfig, 'todos'>('todos')
  const [newTitle, setNewTitle] = useState('')

  const handleCompleteAll = async () => {
    try {
      await client.api['complete-all'].$post({ json: {} })
    } catch (err) {
      console.error('Complete All failed', err)
    }
  }

  if (isLoading) return <div className="p-6">Loading todos...</div>
  if (isError) return (
    <div className="p-6">
      <p className="text-red-500">Failed to load todos</p>
      <button onClick={() => refetch()} className="mt-2 px-4 py-2 bg-blue-500 text-white rounded">
        Retry
      </button>
    </div>
  )

  return (
    <div>
      <h1 className="text-3xl font-bold mb-6">Todos</h1>

      <div className="flex flex-col sm:flex-row gap-2 mb-6">
        {addError && (
          <p className="text-red-500 text-sm col-span-full">
            Add error: {addError instanceof Error ? addError.message : 'Unknown error'}
          </p>
        )}

        <input
          type="text"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          placeholder="New todo..."
          className="flex-1 px-4 py-2 border rounded"
        />
        <div className="flex gap-2">
          <button
            onClick={handleAdd}
            className="flex-1 sm:flex-none px-6 py-2 bg-green-500 text-white rounded hover:bg-green-600 disabled:opacity-50"
            disabled={isAdding || !newTitle.trim()}
          >
            {isAdding ? 'Saving to live...' : 'Add'}
          </button>
          <button
            onClick={() => refetch()}
            className="flex-1 sm:flex-none px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600"
          >
            Refresh
          </button>
          <button
            onClick={handleCompleteAll}
            className="flex-1 sm:flex-none px-4 py-2 bg-purple-500 text-white rounded hover:bg-purple-600"
          >
            Complete All
          </button>
        </div>
      </div>

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

      {todos.length === 0 && (
        <p className="text-gray-500 text-center py-8">No todos yet. Add one above!</p>
      )}
    </div>
  )

  function handleAdd() {
    if (newTitle.trim()) {
      add({ title: newTitle.trim() }, {
        onSuccess: () => setNewTitle('')
      })
    }
  }
}

function NotesList() {
  const { data: notes, isLoading, isError, refetch, add, isAdding, addError, remove,
          isEntitySaving } = useCollection<typeof collectionsConfig, 'notes'>('notes')
  const [newTitle, setNewTitle] = useState('')
  const [newContent, setNewContent] = useState('')

  if (isLoading) return <div className="p-6">Loading notes...</div>
  if (isError) return (
    <div className="p-6">
      <p className="text-red-500">Failed to load notes</p>
      <button onClick={() => refetch()} className="mt-2 px-4 py-2 bg-blue-500 text-white rounded">
        Retry
      </button>
    </div>
  )

  return (
    <div>
      <h1 className="text-3xl font-bold mb-6">Notes</h1>

      <div className="flex flex-col gap-2 mb-6">
        {addError && (
          <p className="text-red-500 text-sm">
            Note add error: {addError instanceof Error ? addError.message : 'Unknown error'}
          </p>
        )}

        <input
          type="text"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="Note title..."
          className="px-4 py-2 border rounded"
        />
        <textarea
          value={newContent}
          onChange={(e) => setNewContent(e.target.value)}
          placeholder="Note content..."
          className="px-4 py-2 border rounded"
          rows={3}
        />
        <div className="flex gap-2">
          <button
            onClick={handleAdd}
            className="flex-1 sm:flex-none px-6 py-2 bg-green-500 text-white rounded hover:bg-green-600 disabled:opacity-50"
            disabled={isAdding || !newTitle.trim()}
          >
            {isAdding ? 'Saving to live...' : 'Add Note'}
          </button>
          <button
            onClick={() => refetch()}
            className="flex-1 sm:flex-none px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600"
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="space-y-4">
        {notes
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .map((note) => (
          <div
            key={note.id}
            className="p-4 border rounded"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1">
                <h3 className="font-semibold text-lg">{note.title}</h3>
                {note.content && <p className="text-gray-600 mt-1">{note.content}</p>}
              </div>
              <button
                onClick={() => remove(note.id)}
                className="px-3 py-1 bg-red-500 text-white rounded hover:bg-red-600 text-sm shrink-0"
                disabled={isEntitySaving(note.id)}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      {notes.length === 0 && (
        <p className="text-gray-500 text-center py-8">No notes yet. Add one above!</p>
      )}
    </div>
  )

  function handleAdd() {
    if (newTitle.trim()) {
      add({ title: newTitle.trim(), content: newContent.trim() || undefined }, {
        onSuccess: () => {
          setNewTitle('')
          setNewContent('')
        }
      })
    }
  }
}

export default App
