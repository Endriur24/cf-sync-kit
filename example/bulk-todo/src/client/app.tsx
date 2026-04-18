import { useState } from 'react'
import { useCollection, useLiveSync, useConnectionStatus } from 'cf-sync-kit'
import { collectionsConfig } from '../../shared/schema'

const App = () => {
  useLiveSync()
  const { status } = useConnectionStatus()

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-8">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-4xl font-bold">Bulk Todo App</h1>
        <ConnectionStatus status={status} />
      </div>
      <p className="text-gray-600">This app demonstrates ONLY bulk operations: addMany, updateMany, removeMany</p>
      <TodosList />
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
  const { data: todos, isLoading, isError, refetch, addMany, updateMany, removeMany,
          isAddingMany, isUpdatingMany, isRemovingMany,
          addManyError, updateManyError, removeManyError } = useCollection<typeof collectionsConfig, 'todos'>('todos', { debug: true })
  
  const [newTitles, setNewTitles] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])

  if (isLoading) return <div className="p-6">Loading todos...</div>
  if (isError) return (
    <div className="p-6">
      <p className="text-red-500">Failed to load todos</p>
      <button onClick={() => refetch()} className="mt-2 px-4 py-2 bg-blue-500 text-white rounded">
        Retry
      </button>
    </div>
  )

  const toggleSelection = (id: string) => {
    setSelectedIds(prev => 
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    )
  }

  const selectAll = () => {
    setSelectedIds(todos.map(t => t.id))
  }

  const deselectAll = () => {
    setSelectedIds([])
  }

  const handleAddMany = () => {
    const titles = newTitles.split('\n').filter(t => t.trim())
    if (titles.length > 0) {
      const payloads = titles.map(title => ({ title: title.trim() }))
      addMany(payloads, {
        onSuccess: () => setNewTitles('')
      })
    }
  }

  const handleCompleteSelected = () => {
    if (selectedIds.length === 0) return
    const payloads = selectedIds.map(id => ({ id, data: { completed: true } }))
    updateMany(payloads)
  }

  const handleUncompleteSelected = () => {
    if (selectedIds.length === 0) return
    const payloads = selectedIds.map(id => ({ id, data: { completed: false } }))
    updateMany(payloads)
  }

  const handleDeleteSelected = () => {
    if (selectedIds.length === 0) return
    removeMany(selectedIds)
    setSelectedIds([])
  }

  const handleCompleteAll = () => {
    if (todos.length === 0) return
    const payloads = todos.map(todo => ({ id: todo.id, data: { completed: true } }))
    updateMany(payloads)
  }

  const handleDeleteCompleted = () => {
    const completedIds = todos.filter(t => t.completed).map(t => t.id)
    if (completedIds.length === 0) return
    removeMany(completedIds)
  }

  return (
    <div>
      <h2 className="text-2xl font-bold mb-4">Bulk Operations Demo</h2>

      {/* Add Many Section */}
      <div className="mb-8 p-4 border rounded bg-gray-50">
        <h3 className="text-lg font-semibold mb-2">addMany() - Add multiple todos at once</h3>
        <p className="text-sm text-gray-600 mb-2">Enter one todo per line:</p>
        {addManyError && (
          <p className="text-red-500 text-sm mb-2">
            Add error: {addManyError instanceof Error ? addManyError.message : 'Unknown error'}
          </p>
        )}
        <textarea
          value={newTitles}
          onChange={(e) => setNewTitles(e.target.value)}
          placeholder={"Buy milk\nWalk the dog\nFinish report"}
          className="w-full px-4 py-2 border rounded mb-2"
          rows={4}
        />
        <button
          onClick={handleAddMany}
          className="px-6 py-2 bg-green-500 text-white rounded hover:bg-green-600 disabled:opacity-50"
          disabled={isAddingMany || !newTitles.trim()}
        >
          {isAddingMany ? 'Adding...' : `Add ${newTitles.split('\n').filter(t => t.trim()).length} Todos`}
        </button>
      </div>

      {/* Bulk Actions Section */}
      {todos.length > 0 && (
        <div className="mb-6 p-4 border rounded bg-blue-50">
          <h3 className="text-lg font-semibold mb-3">Bulk Actions on Selected/All</h3>
          <div className="flex flex-wrap gap-2 mb-3">
            <button
              onClick={selectAll}
              className="px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600"
            >
              Select All
            </button>
            <button
              onClick={deselectAll}
              className="px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600"
            >
              Deselect All
            </button>
            <span className="self-center text-sm text-gray-600">
              {selectedIds.length} of {todos.length} selected
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleCompleteSelected}
              className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
              disabled={isUpdatingMany || selectedIds.length === 0}
            >
              {isUpdatingMany ? 'Updating...' : 'Complete Selected'}
            </button>
            <button
              onClick={handleUncompleteSelected}
              className="px-4 py-2 bg-yellow-500 text-white rounded hover:bg-yellow-600 disabled:opacity-50"
              disabled={isUpdatingMany || selectedIds.length === 0}
            >
              Uncomplete Selected
            </button>
            <button
              onClick={handleDeleteSelected}
              className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600 disabled:opacity-50"
              disabled={isRemovingMany || selectedIds.length === 0}
            >
              {isRemovingMany ? 'Deleting...' : 'Delete Selected'}
            </button>
            <button
              onClick={handleCompleteAll}
              className="px-4 py-2 bg-purple-500 text-white rounded hover:bg-purple-600 disabled:opacity-50"
              disabled={isUpdatingMany || todos.length === 0}
            >
              Complete ALL
            </button>
            <button
              onClick={handleDeleteCompleted}
              className="px-4 py-2 bg-orange-500 text-white rounded hover:bg-orange-600 disabled:opacity-50"
              disabled={isRemovingMany || todos.filter(t => t.completed).length === 0}
            >
              Delete Completed
            </button>
          </div>
          {updateManyError && (
            <p className="text-red-500 text-sm mt-2">
              Update error: {updateManyError instanceof Error ? updateManyError.message : 'Unknown error'}
            </p>
          )}
          {removeManyError && (
            <p className="text-red-500 text-sm mt-2">
              Delete error: {removeManyError instanceof Error ? removeManyError.message : 'Unknown error'}
            </p>
          )}
        </div>
      )}

      {/* Todo List */}
      <ul className="space-y-2">
        {todos
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .map((todo) => (
            <li
              key={todo.id}
              className={`flex items-center gap-3 p-3 border rounded ${selectedIds.includes(todo.id) ? 'bg-blue-100' : ''}`}
            >
              <input
                type="checkbox"
                checked={selectedIds.includes(todo.id)}
                onChange={() => toggleSelection(todo.id)}
                className="w-5 h-5"
              />
              <span className={`flex-1 ${todo.completed ? 'line-through text-gray-500' : ''}`}>
                {todo.title}
              </span>
              <span className="text-xs text-gray-400">
                {todo.completed ? '✓' : '○'}
              </span>
            </li>
          ))}
      </ul>

      {todos.length === 0 && (
        <p className="text-gray-500 text-center py-8">No todos yet. Add multiple using the form above!</p>
      )}
    </div>
  )
}

export default App
