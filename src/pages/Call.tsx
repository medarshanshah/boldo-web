import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useHistory, useRouteMatch } from 'react-router-dom'
import { differenceInMinutes, differenceInSeconds, differenceInYears, parseISO } from 'date-fns'
import { Transition } from '@headlessui/react'
import axios from 'axios'

import Stream, { CallState } from '../components/Stream'
import Layout from '../components/Layout'
import DateFormatted from '../components/DateFormatted'
import { SocketContext } from '../App'
import { useToasts } from '../components/Toast'
import { avatarPlaceholder } from '../util/helpers'

type Status = Boldo.Appointment['status']
type AppointmentWithPatient = Boldo.Appointment & { patient: iHub.Patient }
type CallStatus = { connecting: boolean }

const Gate = () => {
  const history = useHistory()
  const socket = useContext(SocketContext)
  const { addToast, addErrorToast } = useToasts()

  let match = useRouteMatch<{ id: string }>('/appointments/:id/call')
  const id = match?.params.id

  const [instance, setInstance] = useState(0)
  const [appointment, setAppointment] = useState<AppointmentWithPatient & { token: string }>()
  const [statusText, setStatusText] = useState('')
  const [callStatus, setCallStatus] = useState<CallStatus>({ connecting: false })

  const token = appointment?.token || ''

  const updateStatus = useCallback(
    async (status?: Status) => {
      setInstance(0)
      if (!status) return

      try {
        if (['closed', 'open'].includes(status)) await axios.post(`/profile/doctor/appointments/${id}`, { status })
        setAppointment(appointment => {
          if (!appointment || !status) return
          return { ...appointment, status: status }
        })
      } catch (err) {
        console.log(err)
        addErrorToast('No se actualizó el estado de cita.')
      }
    },
    [addErrorToast, id]
  )

  useEffect(() => {
    let mounted = true

    const load = async () => {
      try {
        const res = await axios.get<AppointmentWithPatient & { token: string }>(`/profile/doctor/appointments/${id}`)
        if (mounted) setAppointment(res.data)
      } catch (err) {
        console.log(err)
        if (mounted) {
          addErrorToast('¡Fallo en la carga de la cita!')
          history.replace(`/`)
        }
      }
    }

    load()

    return () => {
      mounted = false
    }
  }, [addErrorToast, history, id])

  useEffect(() => {
    if (appointment?.status !== 'upcoming') return
    let mounted = true

    const calculate = async () => {
      if (!mounted) return
      const minutes = differenceInMinutes(parseISO(appointment.start as any), Date.now())
      if (minutes < 15) {
        clearInterval(timer)
        const res = await axios.get<AppointmentWithPatient & { token: string }>(`/profile/doctor/appointments/${id}`)
        if (mounted) setAppointment(res.data)
      } else if (minutes < 16) {
        const seconds = differenceInSeconds(parseISO(appointment.start as any), Date.now())
        setStatusText(`La sala de espera se abre en ${seconds + 1 - 60 * 15} segundos`)
      } else if (minutes < 60) {
        setStatusText(`La sala de espera se abre en ${minutes - 14} minutos`)
      } else {
        setStatusText(`La sala de espera se abrirá 15 minutos antes del inicio de la cita.`)
      }
    }
    calculate()
    const timer = setInterval(() => calculate(), 1000)
    return () => {
      clearInterval(timer)
      mounted = false
    }
  }, [appointment, id])

  useEffect(() => {
    if (!socket) return
    if (appointment?.status !== 'open' || !token) return

    socket.emit('ready?', { room: id, token })
    socket.on('ready!', (roomId: string) => {
      console.log('READY!')
      if (roomId !== id) return
      setInstance(i => i + 1)
    })

    return () => {
      socket.off('ready!')
    }
  }, [appointment, id, socket, token])

  useEffect(() => {
    if (!socket) return
    if (appointment?.status !== 'open') return
    socket.on('end call', () => {
      addToast({ type: 'success', title: 'Llamada Finalizada', text: '¡El paciente ha terminado la llamada!' })
      updateStatus()
    })
    return () => {
      socket.off('end call')
    }
  }, [addToast, appointment, socket, updateStatus])

  const onCallStateChange = useCallback(
    (callState: CallState) => {
      switch (callState) {
        case 'connecting': {
          break
        }
        case 'connected': {
          setCallStatus({ connecting: false })
          break
        }
        case 'disconnected': {
          setCallStatus({ connecting: true })
          break
        }
        case 'closed': {
          setCallStatus({ connecting: false })
          setInstance(0)
          addToast({ type: 'warning', title: 'Conexión perdida', text: '¡Perdimos la conexión con el paciente!' })
          socket?.emit('ready?', { room: id, token })
          break
        }
      }
    },
    [addToast, token, id, socket]
  )

  if (!id) return null

  if (!appointment)
    return (
      <Layout>
        <div className='h-1 fakeload-15 bg-primary-500' />
      </Layout>
    )

  return (
    <Layout>
      {instance === 0 ? (
        <div className='flex flex-col h-full md:flex-row'>
          <CallStatusMessage status={appointment.status} statusText={statusText} updateStatus={updateStatus} />
          <div className='md:max-w-xl'>
            <Sidebar appointment={appointment} />
          </div>
        </div>
      ) : (
        <Call
          appointment={appointment}
          id={id}
          token={token}
          instance={instance}
          updateStatus={updateStatus}
          onCallStateChange={onCallStateChange}
          callStatus={callStatus}
        />
      )}
    </Layout>
  )
}

export default Gate

interface CallProps {
  id: string
  token: string
  instance: number
  updateStatus: (status?: Status) => Promise<void>
  appointment: AppointmentWithPatient
  onCallStateChange: (arg: CallState) => void
  callStatus: CallStatus
}

const Call = ({ id, token, instance, updateStatus, appointment, onCallStateChange, callStatus }: CallProps) => {
  const { addToast } = useToasts()
  const socket = useContext(SocketContext)
  const mediaStream = useUserMedia()

  const container = useRef<HTMLDivElement>(null)
  const stream = useRef<HTMLVideoElement>(null)
  const video = useRef<HTMLVideoElement>(null)

  const [showCallMenu, setShowCallMenu] = useState(false)
  const [showSidebarMenu, setShowSidebarMenu] = useState(false)

  const [audioEnabled, setAudioEnabled] = useState(true)
  const [videoEnabled, setVideoEnabled] = useState(true)

  const muteAudio = () => {
    if (!mediaStream) return
    setAudioEnabled(() => {
      const newState = !mediaStream.getAudioTracks()[0].enabled
      mediaStream.getAudioTracks()[0].enabled = newState
      return newState
    })

    console.log(mediaStream?.getAudioTracks()[0].enabled)
  }

  const muteVideo = () => {
    if (!mediaStream) return
    setVideoEnabled(() => {
      const newState = !mediaStream.getVideoTracks()[0].enabled
      mediaStream.getVideoTracks()[0].enabled = newState
      return newState
    })
  }

  // NOTE: Mutes audio for development comfort
  // useEffect(() => {
  //   if (mediaStream) {
  //     mediaStream.getAudioTracks()[0].enabled = false
  //     setAudioEnabled(false)
  //   }
  // }, [mediaStream])

  const hangUp = async () => {
    socket?.emit('end call', { room: id, token })
    updateStatus('closed')
    addToast({ type: 'success', title: 'Llamada Finalizada', text: '¡Has terminado la llamada!' })
  }

  if (mediaStream && video.current && !video.current?.srcObject) {
    video.current.srcObject = mediaStream
  }

  return (
    <div ref={container} className='flex w-full h-full lg:h-screen bg-cool-gray-50'>
      <div className='relative flex-1'>
        <Stream
          ref={stream}
          room={id}
          token={token}
          instance={instance}
          mediaStream={mediaStream}
          socket={socket}
          onCallStateChange={onCallStateChange}
        />

        <div
          className='absolute top-0 left-0 flex items-center justify-between w-full px-10 py-4 blur-10'
          style={{ backgroundColor: 'rgb(255 255 255 / 75%)' }}
        >
          <h3 className='text-lg font-medium leading-6 text-cool-gray-900'>
            {appointment.patient.givenName} {appointment.patient.familyName}
          </h3>
          <div className='flex items-center space-x-4'>
            <p className='mt-1 text-sm font-semibold leading-5 text-cool-gray-700'>
              <Timer />
            </p>
            <button
              className='p-2 rounded-full inline-box text-cool-gray-700 hover:bg-cool-gray-100 hover:text-cool-gray-500 focus:outline-none focus:shadow-outline focus:text-cool-gray-500'
              aria-label='Pantalla completa'
              onClick={() => {
                const elem = container.current as any
                if (!elem) return

                if (document.fullscreenElement) return document.exitFullscreen()
                else if ((document as any).webkitFullscreenElement)
                  return (document as any).webkitExitFullscreen() /* Safari */
                if (elem.requestFullscreen) return elem.requestFullscreen()
                else if (elem.webkitRequestFullscreen) return elem.webkitRequestFullscreen() /* Safari */
              }}
            >
              <svg className='w-6 h-6' viewBox='0 0 24 24' fill='currentColor' xmlns='http://www.w3.org/2000/svg'>
                <path
                  fillRule='evenodd'
                  clipRule='evenodd'
                  d='M7 9C7 9.55 6.55 10 6 10C5.45 10 5 9.55 5 9V6C5 5.45 5.45 5 6 5H9C9.55 5 10 5.45 10 6C10 6.55 9.55 7 9 7H7V9ZM5 15C5 14.45 5.45 14 6 14C6.55 14 7 14.45 7 15V17H9C9.55 17 10 17.45 10 18C10 18.55 9.55 19 9 19H6C5.45 19 5 18.55 5 18V15ZM17 17H15C14.45 17 14 17.45 14 18C14 18.55 14.45 19 15 19H18C18.55 19 19 18.55 19 18V15C19 14.45 18.55 14 18 14C17.45 14 17 14.45 17 15V17ZM15 7C14.45 7 14 6.55 14 6C14 5.45 14.45 5 15 5H18C18.55 5 19 5.45 19 6V9C19 9.55 18.55 10 18 10C17.45 10 17 9.55 17 9V7H15Z'
                />
              </svg>
            </button>
            {(document as any).pictureInPictureEnabled && (
              <button
                className='p-2 rounded-full inline-box text-cool-gray-700 hover:bg-cool-gray-100 hover:text-cool-gray-500 focus:outline-none focus:shadow-outline focus:text-cool-gray-500'
                aria-label='Imagen en imagen'
                onClick={() => {
                  if (!stream.current) return

                  if ((document as any).pictureInPictureEnabled && !(stream.current as any).disablePictureInPicture) {
                    try {
                      if ((document as any).pictureInPictureElement) {
                        ;(document as any).exitPictureInPicture()
                      }
                      ;(stream.current as any).requestPictureInPicture()?.catch((err: Error) => console.log(err))
                    } catch (err) {
                      console.error(err)
                    }
                  }
                }}
              >
                <svg className='w-6 h-6' viewBox='0 0 24 24' fill='currentColor' xmlns='http://www.w3.org/2000/svg'>
                  <path
                    fillRule='evenodd'
                    clipRule='evenodd'
                    d='M23 19V4.98C23 3.88 22.1 3 21 3H3C1.9 3 1 3.88 1 4.98V19C1 20.1 1.9 21 3 21H21C22.1 21 23 20.1 23 19ZM18 11H12C11.45 11 11 11.45 11 12V16C11 16.55 11.45 17 12 17H18C18.55 17 19 16.55 19 16V12C19 11.45 18.55 11 18 11ZM4 19.02H20C20.55 19.02 21 18.57 21 18.02V5.97C21 5.42 20.55 4.97 20 4.97H4C3.45 4.97 3 5.42 3 5.97V18.02C3 18.57 3.45 19.02 4 19.02Z'
                  />
                </svg>
              </button>
            )}
            <button
              className='p-2 text-white rounded-full inline-box bg-primary-500 hover:bg-primary-400 focus:outline-none focus:shadow-outline'
              onClick={() => setShowSidebarMenu(showSidebarMenu => !showSidebarMenu)}
            >
              <svg
                className='w-6 h-6'
                xmlns='http://www.w3.org/2000/svg'
                fill='none'
                viewBox='0 0 24 24'
                stroke='currentColor'
              >
                <path
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  strokeWidth={2}
                  d='M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z'
                />
              </svg>
            </button>
          </div>
        </div>
        <div className='absolute bottom-0 left-0 flex items-end justify-between w-full px-10 py-8'>
          <div className='absolute'>
            <div className='aspect-h-16 aspect-w-9' style={{ maxWidth: '14rem', minWidth: '8rem', width: '15vw' }}>
              <video
                ref={video}
                onCanPlay={e => (e.target as HTMLVideoElement).play()}
                autoPlay
                playsInline
                muted
                style={{ transform: 'rotateY(180deg)' }}
                className='object-cover rounded-lg'
              />
            </div>
          </div>
          <div />
          <button
            onClick={hangUp}
            className='flex items-center justify-center w-12 h-12 ml-4 text-white bg-red-600 rounded-full'
          >
            <svg
              style={{ transform: 'rotate(134deg)' }}
              height='30px'
              width='30px'
              xmlns='http://www.w3.org/2000/svg'
              fill='none'
              viewBox='0 0 24 24'
              stroke='currentColor'
            >
              <path
                strokeLinecap='round'
                strokeLinejoin='round'
                strokeWidth={2}
                d='M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z'
              />
            </svg>
          </button>
          <div className='flex flex-col items-end space-y-4'>
            {showCallMenu && (
              <>
                <div className='flex items-center'>
                  <p className='p-1 text-xs bg-white rounded opacity-75'>{mediaStream?.getAudioTracks()[0].label}</p>
                  <button
                    className='flex items-center justify-center w-12 h-12 ml-4 text-white bg-gray-600 rounded-full'
                    onClick={muteAudio}
                  >
                    {audioEnabled ? (
                      <svg
                        className='w-6 h-6'
                        viewBox='0 0 24 24'
                        fill='currentColor'
                        xmlns='http://www.w3.org/2000/svg'
                      >
                        <path
                          fillRule='evenodd'
                          clipRule='evenodd'
                          d='M12 1C14.2091 1 16 2.79086 16 5V12C16 14.2091 14.2091 16 12 16C9.79086 16 8 14.2091 8 12V5C8 2.79086 9.79086 1 12 1ZM13 19.9381V21H16V23H8V21H11V19.9381C7.05369 19.446 4 16.0796 4 12V10H6V12C6 15.3137 8.68629 18 12 18C15.3137 18 18 15.3137 18 12V10H20V12C20 16.0796 16.9463 19.446 13 19.9381ZM10 5C10 3.89543 10.8954 3 12 3C13.1046 3 14 3.89543 14 5V12C14 13.1046 13.1046 14 12 14C10.8954 14 10 13.1046 10 12V5Z'
                        />
                      </svg>
                    ) : (
                      <svg
                        className='w-6 h-6'
                        viewBox='0 0 24 24'
                        fill='currentColor'
                        xmlns='http://www.w3.org/2000/svg'
                      >
                        <path
                          fillRule='evenodd'
                          clipRule='evenodd'
                          d='M8.00008 9.41421L1.29297 2.70711L2.70718 1.29289L22.7072 21.2929L21.293 22.7071L16.9057 18.3199C15.7992 19.18 14.4608 19.756 13.0001 19.9381V21H16.0001V23H8.00008V21H11.0001V19.9381C7.05376 19.446 4.00008 16.0796 4.00008 12V10H6.00008V12C6.00008 15.3137 8.68637 18 12.0001 18C13.2959 18 14.4958 17.5892 15.4766 16.8907L14.032 15.4462C13.4365 15.7981 12.7419 16 12.0001 16C9.79094 16 8.00008 14.2091 8.00008 12V9.41421ZM12.5181 13.9323C12.3529 13.9764 12.1792 14 12.0001 14C10.8955 14 10.0001 13.1046 10.0001 12V11.4142L12.5181 13.9323ZM14.0001 5V9.78579L16.0001 11.7858V5C16.0001 2.79086 14.2092 1 12.0001 1C10.1614 1 8.61246 2.24059 8.14468 3.93039L10.0001 5.78579V5C10.0001 3.89543 10.8955 3 12.0001 3C13.1046 3 14.0001 3.89543 14.0001 5ZM19.3585 15.1442L17.7908 13.5765C17.9273 13.0741 18.0001 12.5456 18.0001 12V10H20.0001V12C20.0001 13.1162 19.7715 14.1791 19.3585 15.1442Z'
                        />
                      </svg>
                    )}
                  </button>
                </div>
                <div className='flex items-center'>
                  <p className='p-1 text-xs bg-white rounded opacity-75'>{mediaStream?.getVideoTracks()[0].label}</p>
                  <button
                    className='flex items-center justify-center w-12 h-12 ml-4 text-white bg-gray-600 rounded-full'
                    onClick={muteVideo}
                  >
                    {videoEnabled ? (
                      <svg
                        className='w-6 h-6'
                        viewBox='0 0 24 24'
                        fill='currentColor'
                        xmlns='http://www.w3.org/2000/svg'
                      >
                        <path
                          fillRule='evenodd'
                          clipRule='evenodd'
                          d='M3 5H15C16.1046 5 17 5.89543 17 7V8.38197L23 5.38197V18.618L17 15.618V17C17 18.1046 16.1046 19 15 19H3C1.89543 19 1 18.1046 1 17V7C1 5.89543 1.89543 5 3 5ZM17 13.382L21 15.382V8.61803L17 10.618V13.382ZM3 7V17H15V7H3Z'
                        />
                      </svg>
                    ) : (
                      <svg
                        className='w-6 h-6'
                        viewBox='0 0 24 24'
                        fill='currentColor'
                        xmlns='http://www.w3.org/2000/svg'
                      >
                        <path
                          fillRule='evenodd'
                          clipRule='evenodd'
                          d='M1.70718 0.292892L0.292969 1.70711L3.58586 5H3.00008C1.89551 5 1.00008 5.89543 1.00008 7V17C1.00008 18.1046 1.89551 19 3.00008 19H15.0001C15.7022 19 16.3198 18.6382 16.6767 18.0908L22.293 23.7071L23.7072 22.2929L1.70718 0.292892ZM15.0001 16.4142L5.58586 7H3.00008V17H15.0001V16.4142ZM17.0001 8.38197L23.0001 5.38197V18.3701L21.0001 16.3701V8.61803L17.0001 10.618V13.0008L15.0001 11.0008V7H10.9993L8.99929 5H15.0001C16.1046 5 17.0001 5.89543 17.0001 7V8.38197Z'
                        />
                      </svg>
                    )}
                  </button>
                </div>
              </>
            )}
            <button
              className='flex items-center justify-center w-12 h-12 ml-4 text-white bg-gray-600 rounded-full'
              onClick={() => {
                setShowCallMenu(menuOpen => !menuOpen)
              }}
            >
              <svg
                className={`w-6 h-6 transition-transform duration-150 ease-in-out ${
                  showCallMenu && 'transform rotate-90'
                }`}
                xmlns='http://www.w3.org/2000/svg'
                fill='none'
                viewBox='0 0 24 24'
                stroke='currentColor'
              >
                <path
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  strokeWidth={2}
                  d='M5 12h.01M12 12h.01M19 12h.01M6 12a1 1 0 11-2 0 1 1 0 012 0zm7 0a1 1 0 11-2 0 1 1 0 012 0zm7 0a1 1 0 11-2 0 1 1 0 012 0z'
                />
              </svg>
            </button>
          </div>
        </div>
        {callStatus.connecting && (
          <div
            className='absolute flex mb-20 -translate-x-1/2 -translate-y-1/2 bg-white rounded-xl top-1/2 left-1/2'
            style={{ transform: 'translate(-50%, -50%)' }}
          >
            <svg
              className='w-10 h-10 m-4 text-red-500 animate-spin'
              xmlns='http://www.w3.org/2000/svg'
              fill='none'
              viewBox='0 0 24 24'
            >
              <circle className='opacity-25' cx='12' cy='12' r='10' stroke='currentColor' strokeWidth='2'></circle>
              <path
                className='opacity-75'
                fill='currentColor'
                d='M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z'
              ></path>
            </svg>
          </div>
        )}
      </div>
      <SidebarContainer
        appointment={appointment}
        show={showSidebarMenu}
        hideSidebar={() => setShowSidebarMenu(false)}
      />
    </div>
  )
}

const useUserMedia = () => {
  const { addErrorToast } = useToasts()
  const [mediaStream, setMediaStream] = useState<MediaStream>()

  useEffect(() => {
    let mounted = true

    // Handle errors which occur when trying to access the local media
    // hardware; that is, exceptions thrown by getUserMedia(). The two most
    // likely scenarios are that the user has no camera and/or microphone
    // or that they declined to share their equipment when prompted.

    const handleGetUserMediaError = (e: Error) => {
      console.log(e)
      switch (e.name) {
        case 'NotFoundError':
          addErrorToast('No se puede abrir la llamada porque no se encontró ninguna cámara y/o micrófono.')
          break
        case 'SecurityError':
          addErrorToast('Error de seguridad. Detalles: ' + e.message)
          break
        case 'PermissionDeniedError':
          addErrorToast('No se puede acceder al micrófono y a la cámara. Detalles: ' + e.message)
          break
        default:
          addErrorToast('Ha ocurrido un error al abrir la cámara y/o el micrófono: ' + e.message)
          break
      }

      //FIXME: Make sure we shut down our end of the RTCPeerConnection so we're ready to try again.
    }

    async function enableStream() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
        if (mounted) setMediaStream(stream)
      } catch (err) {
        handleGetUserMediaError(err)
      }
    }

    if (!mediaStream) enableStream()
    return () => {
      mounted = false
      mediaStream?.getTracks().forEach(track => track.stop())
    }
  }, [addErrorToast, mediaStream])

  return mediaStream
}

const Timer = () => {
  const [start] = useState(new Date())
  const [seconds, setSeconds] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => {
      const seconds = differenceInSeconds(Date.now(), start)
      setSeconds(seconds)
    }, 500)
    return () => clearInterval(interval)
  }, [start])

  const secondsToTime = (e: number) => {
    const h = Math.floor(e / 3600)
      .toString()
      .padStart(2, '0')
    const m = Math.floor((e % 3600) / 60)
      .toString()
      .padStart(2, '0')
    const s = Math.floor(e % 60)
      .toString()
      .padStart(2, '0')

    return h + ':' + m + ':' + s
  }

  const time = useMemo(() => secondsToTime(seconds), [seconds])

  return <>{time}</>
}

interface SidebarContainerProps {
  show: boolean
  hideSidebar: () => void
  appointment: AppointmentWithPatient
}

const SidebarContainer = ({ show, hideSidebar, appointment }: SidebarContainerProps) => {
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleOutsideClick(event: MouseEvent) {
      if (!container.current?.contains(event.target as Node)) {
        if (!show) return
        hideSidebar()
      }
    }

    window.addEventListener('click', handleOutsideClick, true)
    return () => window.removeEventListener('click', handleOutsideClick, true)
  }, [show, hideSidebar])

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (!show) return
      if (event.key === 'Escape') hideSidebar()
    }

    document.addEventListener('keyup', handleEscape)
    return () => document.removeEventListener('keyup', handleEscape)
  }, [show, hideSidebar])

  return (
    <>
      <Transition show={show}>
        <div className='fixed inset-0 overflow-hidden 2xl:hidden'>
          <div className='absolute inset-0 overflow-hidden'>
            <section className='absolute inset-y-0 right-0 flex max-w-full pl-10 mt-16 sm:pl-16 lg:mt-0'>
              {/* Slide-over panel, show/hide based on slide-over state. */}
              <Transition.Child
                enter='transform transition ease-in-out duration-500 sm:duration-700'
                enterFrom='translate-x-full'
                enterTo='translate-x-0'
                leave='transform transition ease-in-out duration-500 sm:duration-700'
                leaveFrom='translate-x-0'
                leaveTo='translate-x-full'
                className='w-screen max-w-xl'
              >
                <div ref={container} className='h-full'>
                  <Sidebar appointment={appointment} hideSidebar={hideSidebar} />
                </div>
              </Transition.Child>
            </section>
          </div>
        </div>
      </Transition>

      <Transition
        show={show}
        enter='transform transition ease-in-out duration-500 sm:duration-700'
        enterFrom='translate-x-full'
        enterTo='translate-x-0'
        leave='transform transition ease-in-out duration-500 sm:duration-700'
        leaveFrom='translate-x-0'
        leaveTo='translate-x-full'
        className='hidden w-screen max-w-xl 2xl:block'
      >
        <Sidebar appointment={appointment} hideSidebar={hideSidebar} />
      </Transition>
    </>
  )
}

interface SidebarProps {
  hideSidebar?: () => void
  appointment: AppointmentWithPatient
}

const Sidebar = ({ hideSidebar, appointment }: SidebarProps) => {
  const birthDate = useMemo(() => {
    return new Intl.DateTimeFormat('default', {
      // weekday: 'long',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(new Date(appointment.patient.birthDate))
  }, [appointment.patient.birthDate])

  const age = useMemo(() => {
    return differenceInYears(Date.now(), new Date(appointment.patient.birthDate))
  }, [appointment.patient.birthDate])

  return (
    <div className='flex flex-col h-full overflow-y-scroll bg-white shadow-xl'>
      <header className='px-4 py-6 sm:px-6'>
        <div className='flex items-start justify-between space-x-3'>
          <h2 className='text-lg font-medium leading-7 text-gray-900'>Perfil</h2>
          {hideSidebar && (
            <div className='flex items-center h-7'>
              <button
                aria-label='Cerrar panel'
                onClick={() => hideSidebar()}
                className='text-gray-400 transition duration-150 ease-in-out hover:text-gray-500'
              >
                <svg
                  className='w-6 h-6'
                  xmlns='http://www.w3.org/2000/svg'
                  fill='none'
                  viewBox='0 0 24 24'
                  stroke='currentColor'
                >
                  <path strokeLinecap='round' strokeLinejoin='round' strokeWidth={2} d='M6 18L18 6M6 6l12 12' />
                </svg>
              </button>
            </div>
          )}
        </div>
      </header>
      {/* Main */}
      <div className='divide-y divide-gray-200'>
        <div className='pb-6'>
          <div className='h-24 gradient-primary sm:h-20 lg:h-28' />
          <div className='flow-root px-4 -mt-12 space-y-6 sm:-mt-8 sm:flex sm:items-end sm:px-6 sm:space-x-6 lg:-mt-15'>
            <div>
              <div className='flex -m-1'>
                <div className='inline-flex overflow-hidden border-4 border-white rounded-lg'>
                  <img
                    className='flex-shrink-0 object-cover w-24 h-24 sm:h-40 sm:w-40 lg:w-48 lg:h-48'
                    src={appointment.patient.photoUrl || avatarPlaceholder('patient', appointment.patient.gender)}
                    alt=''
                  />
                </div>
              </div>
            </div>
            <div className='space-y-5 sm:flex-1'>
              <div>
                <h3 className='text-xl font-bold leading-7 text-gray-900 sm:text-2xl sm:leading-8'>
                  {appointment.patient.givenName} {appointment.patient.familyName}
                </h3>

                <p className='text-sm leading-5 text-gray-500'>
                  <DateFormatted start={appointment.start} end={appointment.end} />
                </p>
              </div>
              {/* <div className='flex flex-wrap'>
                <span className='inline-flex flex-1 w-full mt-3 rounded-md shadow-sm sm:mt-0 sm:ml-3'>
                  <button
                    type='button'
                    className='inline-flex items-center justify-center w-full px-4 py-2 text-sm font-medium leading-5 text-gray-700 transition duration-150 ease-in-out bg-white border border-gray-300 rounded-md hover:text-gray-500 focus:outline-none focus:border-blue-300 focus:shadow-outline-blue active:text-gray-800 active:bg-gray-50'
                  >
                    Add Prescription
                  </button>
                </span>
              </div> */}
            </div>
          </div>
        </div>
        <div className='px-4 py-5 sm:px-0 sm:py-0'>
          <dl className='space-y-8 sm:space-y-0'>
            <div className='sm:flex sm:space-x-6 sm:px-6 sm:py-5'>
              <dt className='text-sm font-medium leading-5 text-gray-500 sm:w-40 sm:flex-shrink-0 lg:w-48'>Edad</dt>
              <dd className='mt-1 text-sm leading-5 text-gray-900 sm:mt-0 sm:col-span-2'>
                {age}
                <time className='pl-2 text-xs' dateTime={appointment.patient.birthDate}>
                  ({birthDate})
                </time>
              </dd>
            </div>
            <div className='sm:flex sm:space-x-6 sm:border-t sm:border-gray-200 sm:px-6 sm:py-5'>
              <dt className='text-sm font-medium leading-5 text-gray-500 sm:w-40 sm:flex-shrink-0 lg:w-48'>Ciudad</dt>
              <dd className='mt-1 text-sm leading-5 text-gray-900 sm:mt-0 sm:col-span-2'>
                {appointment.patient.city || '-'}
              </dd>
            </div>
            <div className='sm:flex sm:space-x-6 sm:border-t sm:border-gray-200 sm:px-6 sm:py-5'>
              <dt className='text-sm font-medium leading-5 text-gray-500 sm:w-40 sm:flex-shrink-0 lg:w-48'>
                Profesión
              </dt>
              <dd className='mt-1 text-sm leading-5 text-gray-900 sm:mt-0 sm:col-span-2'>
                {appointment.patient.job || '-'}
              </dd>
            </div>
            <div className='sm:flex sm:space-x-6 sm:border-t sm:border-gray-200 sm:px-6 sm:py-5'>
              <dt className='text-sm font-medium leading-5 text-gray-500 sm:w-40 sm:flex-shrink-0 lg:w-48'>Género</dt>
              <dd className='mt-1 text-sm leading-5 text-gray-900 sm:mt-0 sm:col-span-2'>
                {lookupGender(appointment.patient.gender) || '-'}
              </dd>
            </div>
            <div className='sm:flex sm:space-x-6 sm:border-t sm:border-gray-200 sm:px-6 sm:py-5'>
              <dt className='text-sm font-medium leading-5 text-gray-500 sm:w-40 sm:flex-shrink-0 lg:w-48'>Teléfono</dt>
              <dd className='mt-1 text-sm leading-5 text-gray-900 sm:mt-0 sm:col-span-2'>
                {appointment.patient.phone || '-'}
              </dd>
            </div>
            <div className='sm:flex sm:space-x-6 sm:border-t sm:border-gray-200 sm:px-6 sm:py-5'>
              <dt className='text-sm font-medium leading-5 text-gray-500 sm:w-40 sm:flex-shrink-0 lg:w-48'>Email</dt>
              <dd className='mt-1 text-sm leading-5 text-gray-900 sm:mt-0 sm:col-span-2'>
                {appointment.patient.email || '-'}
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  )
}

interface CallStatusMessageProps {
  status: Status
  statusText?: string
  updateStatus: (status?: Status) => void
}

const CallStatusMessage = ({ status, statusText, updateStatus }: CallStatusMessageProps) => {
  return (
    <div className='flex items-center justify-center flex-grow'>
      {status === 'upcoming' && (
        <div className='max-w-xs m-4'>
          <div className='flex items-center justify-center w-12 h-12 mx-auto bg-green-100 rounded-full'>
            {/* Heroicon name: clock */}
            <svg
              xmlns='http://www.w3.org/2000/svg'
              fill='none'
              className='w-6 h-6 text-green-600'
              stroke='currentColor'
            >
              <path
                strokeLinecap='round'
                strokeLinejoin='round'
                strokeWidth={2}
                d='M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z'
              />
            </svg>
          </div>
          <div className='mt-3 text-center sm:mt-5'>
            <h3 className='text-lg font-medium leading-6 text-gray-900' id='modal-headline'>
              ¡Se aproxima una cita!
            </h3>
            <div className='mt-2'>
              <p className='text-sm text-gray-500'>{statusText}</p>
            </div>
          </div>
        </div>
      )}
      {status === 'open' && (
        <div className='max-w-xs m-4'>
          <div className='flex items-center justify-center w-12 h-12 mx-auto bg-gray-100 rounded-full'>
            <svg
              className='w-6 h-6 text-secondary-500 animate-spin'
              xmlns='http://www.w3.org/2000/svg'
              fill='none'
              viewBox='0 0 24 24'
            >
              <circle className='opacity-25' cx='12' cy='12' r='10' stroke='currentColor' strokeWidth='2'></circle>
              <path
                className='opacity-75'
                fill='currentColor'
                d='M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z'
              ></path>
            </svg>
          </div>
          <div className='mt-3 text-center sm:mt-5'>
            <h3 className='text-lg font-medium leading-6 text-gray-900' id='modal-headline'>
              Esperando a que el paciente se una
            </h3>
            <div className='mt-2'>
              <p className='text-sm text-gray-500'>Cuando el paciente se una desde la app estarás conectado.</p>
            </div>
          </div>
          <div className='mt-2'>
            <p className='text-sm text-center text-gray-500'>
              Haga clic en "Cerrar Cita" para cerrar la sala de espera para el paciente.
            </p>
          </div>
          <div className='mt-5 sm:mt-4'>
            <button
              onClick={() => updateStatus('closed')}
              className='w-full px-4 py-2 text-base font-medium text-white border border-transparent rounded-md shadow-sm bg-primary-500 hover:bg-primary-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 sm:text-sm'
            >
              Cerrar Cita
            </button>
          </div>
        </div>
      )}

      {status === 'closed' && (
        <div className='max-w-xs m-4'>
          <div className='flex items-center justify-center w-12 h-12 mx-auto bg-gray-100 rounded-full'>
            <svg
              className='w-6 h-6 text-primary-500'
              xmlns='http://www.w3.org/2000/svg'
              fill='none'
              viewBox='0 0 24 24'
              stroke='currentColor'
            >
              <path strokeLinecap='round' strokeLinejoin='round' strokeWidth={2} d='M5 13l4 4L19 7' />
            </svg>
          </div>
          <div className='mt-3 text-center sm:mt-5'>
            <h3 className='text-lg font-medium leading-6 text-gray-900' id='modal-headline'>
              ¡Cita Cerrada!
            </h3>
            <div className='mt-2'>
              <p className='text-sm text-gray-500'>
                El paciente ya no puede unirse. Si desea volver a conectarse con el paciente, por favor haga clic aquí.
              </p>
            </div>
          </div>
          <div className='mt-5 sm:mt-4'>
            <button
              onClick={() => updateStatus('open')}
              className='w-full px-4 py-2 text-base font-medium text-gray-700 bg-white border border-gray-300 rounded-md shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 sm:text-sm'
            >
              Abrir Cita
            </button>
          </div>
        </div>
      )}
      {status === 'locked' && (
        <div className='max-w-xs m-4'>
          <div className='flex items-center justify-center w-12 h-12 mx-auto bg-gray-100 rounded-full'>
            <svg
              className='w-6 h-6 text-secondary-600'
              xmlns='http://www.w3.org/2000/svg'
              fill='none'
              viewBox='0 0 24 24'
              stroke='currentColor'
            >
              <path
                strokeLinecap='round'
                strokeLinejoin='round'
                strokeWidth={2}
                d='M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z'
              />
            </svg>
          </div>
          <div className='mt-3 text-center sm:mt-5'>
            <h3 className='text-lg font-medium leading-6 text-gray-900' id='modal-headline'>
              ¡Cita Finalizada!
            </h3>
            <div className='mt-2'>
              <p className='text-sm text-gray-500'>Esta cita está cerrada.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const lookupGender = (gender: string) => {
  switch (gender) {
    case 'male':
      return 'Masculino'
    case 'female':
      return 'Femenino'
    case 'other':
      return 'Otro'
    default:
      return ''
  }
}
