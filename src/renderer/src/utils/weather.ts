// 天气数据接口
export interface WeatherData {
  temperature: string // 温度
  feelsLike: string // 体感温度
  weatherDesc: string // 天气描述
  humidity: string // 湿度
  wind: string // 风向风力
  city: string // 城市
  icon: string // 天气图标
  updatedAt: string // 更新时间
}

// 默认天气数据（离线或加载失败时使用）
const defaultWeather: WeatherData = {
  temperature: '--',
  feelsLike: '--',
  weatherDesc: '暂无数据',
  humidity: '--',
  wind: '--',
  city: '未知位置',
  icon: 'cloud',
  updatedAt: ''
}

// 天气图标映射
const weatherIconMap: Record<string, string> = {
  Sunny: 'sunny',
  Clear: 'sunny',
  'Partly cloudy': 'partly-cloudy',
  Cloudy: 'cloudy',
  Overcast: 'overcast',
  Mist: 'mist',
  Fog: 'fog',
  'Freezing fog': 'fog',
  'Patchy rain possible': 'drizzle',
  'Patchy snow possible': 'snow',
  'Patchy sleet possible': 'sleet',
  'Patchy freezing drizzle possible': 'drizzle',
  'Thundery outbreaks possible': 'thunder',
  'Blowing snow': 'snow',
  Blizzard: 'snow',
  'Light drizzle': 'drizzle',
  'Patchy light drizzle': 'drizzle',
  'Freezing drizzle': 'drizzle',
  'Heavy freezing drizzle': 'drizzle',
  'Light rain': 'rain',
  'Moderate rain at times': 'rain',
  'Moderate rain': 'rain',
  'Heavy rain at times': 'heavy-rain',
  'Heavy rain': 'heavy-rain',
  'Light freezing rain': 'rain',
  'Moderate or heavy freezing rain': 'heavy-rain',
  'Light sleet': 'sleet',
  'Moderate or heavy sleet': 'sleet',
  'Light snow': 'snow',
  'Patchy light snow': 'snow',
  'Moderate snow': 'snow',
  'Patchy moderate snow': 'snow',
  'Heavy snow': 'heavy-snow',
  'Patchy heavy snow': 'heavy-snow',
  'Ice pellets': 'sleet',
  'Moderate or heavy rain shower': 'heavy-rain',
  'Torrential rain shower': 'heavy-rain',
  'Light sleet showers': 'sleet',
  'Moderate or heavy sleet showers': 'sleet',
  'Light snow showers': 'snow',
  'Moderate or heavy snow showers': 'snow',
  'Light showers of ice pellets': 'sleet',
  'Moderate or heavy showers of ice pellets': 'sleet',
  'Patchy light rain with thunder': 'thunder',
  'Moderate or heavy rain with thunder': 'thunder',
  'Patchy light snow with thunder': 'thunder',
  'Moderate or heavy snow with thunder': 'thunder',
  '多云': 'cloudy',
  '晴': 'sunny',
  '阴': 'overcast',
  '小雨': 'rain',
  '中雨': 'rain',
  '大雨': 'heavy-rain',
  '暴雨': 'heavy-rain',
  '雷阵雨': 'thunder',
  '小雪': 'snow',
  '中雪': 'snow',
  '大雪': 'heavy-snow',
  '雾': 'fog',
  '霾': 'mist'
}

export function getWeatherIcon(desc: string): string {
  return weatherIconMap[desc] || 'cloud'
}

/**
 * 获取天气数据（通过wttr.in API，免费无需key）
 * 使用主进程代理请求以避免CORS问题
 */
export async function fetchWeather(city?: string): Promise<WeatherData> {
  try {
    // 使用wttr.in的JSON格式API
    const cityParam = city ? encodeURIComponent(city) : ''
    const url = `https://wttr.in/${cityParam}?format=j1&lang=zh`

    const { status, data } = await window.dot.httpRequest('GET', url)

    if (status >= 200 && status < 300) {
      const weatherData = JSON.parse(data)
      const current = weatherData.current_condition[0]
      const area = weatherData.nearest_area[0]

      // 获取中文天气描述
      let weatherDesc = current.weatherDesc[0].value
      if (current.lang_zh && current.lang_zh[0]) {
        weatherDesc = current.lang_zh[0].value
      }

      const cityName = area.areaName[0].value || city || '当前位置'

      return {
        temperature: current.temp_C,
        feelsLike: current.FeelsLikeC,
        weatherDesc,
        humidity: current.humidity,
        wind: `${current.winddir16Point} ${current.windspeedKmph}km/h`,
        city: cityName,
        icon: getWeatherIcon(weatherDesc),
        updatedAt: new Date().toLocaleTimeString('zh-CN')
      }
    } else {
      console.warn(`天气API返回错误状态: ${status}`)
      return { ...defaultWeather, city: city || '未知位置' }
    }
  } catch (error) {
    console.error('获取天气数据失败:', error)
    return { ...defaultWeather, city: city || '未知位置' }
  }
}

/**
 * 获取天气图标SVG
 */
export function getWeatherIconSvg(icon: string): string {
  const icons: Record<string, string> = {
    sunny: `
      <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
        <circle cx="32" cy="32" r="14" fill="#FFD93D"/>
        <g stroke="#FFD93D" stroke-width="3" stroke-linecap="round">
          <line x1="32" y1="6" x2="32" y2="14"/>
          <line x1="32" y1="50" x2="32" y2="58"/>
          <line x1="6" y1="32" x2="14" y2="32"/>
          <line x1="50" y1="32" x2="58" y2="32"/>
          <line x1="13" y1="13" x2="19" y2="19"/>
          <line x1="45" y1="45" x2="51" y2="51"/>
          <line x1="13" y1="51" x2="19" y2="45"/>
          <line x1="45" y1="19" x2="51" y2="13"/>
        </g>
      </svg>`,
    'partly-cloudy': `
      <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
        <circle cx="22" cy="22" r="10" fill="#FFD93D"/>
        <path d="M46 42c0 4.4-3.6 8-8 8H20c-5.5 0-10-4.5-10-10s4.5-10 10-10c1 0 2 .1 3 .4C24.5 24 30.5 20 37 20c8.3 0 15 6.7 15 15 0 1.3-.2 2.6-.5 3.8" fill="#E8E8E8"/>
      </svg>`,
    cloudy: `
      <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
        <path d="M48 44c0 4.4-3.6 8-8 8H20c-5.5 0-10-4.5-10-10s4.5-10 10-10c1 0 2 .1 3 .4C26.5 26 32.5 22 39 22c8.3 0 15 6.7 15 15 0 1.3-.2 2.6-.5 3.8" fill="#D0D0D0"/>
        <path d="M40 28c0 3.3-2.7 6-6 6H16c-3.3 0-6-2.7-6-6s2.7-6 6-6c1 0 1.9.3 2.7.8C20.9 17.6 25.7 14 31 14c7.2 0 13 5.8 13 13" fill="#F5F5F5"/>
      </svg>`,
    overcast: `
      <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
        <path d="M52 36c0 4.4-3.6 8-8 8H16c-5.5 0-10-4.5-10-10s4.5-10 10-10c1 0 2 .1 3 .4C20.5 20 26.5 16 33 16c8.3 0 15 6.7 15 15 0 1.3-.2 2.6-.5 3.8" fill="#BDBDBD"/>
      </svg>`,
    rain: `
      <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
        <path d="M48 34c0 4.4-3.6 8-8 8H20c-5.5 0-10-4.5-10-10s4.5-10 10-10c1 0 2 .1 3 .4C26.5 20 32.5 16 39 16c8.3 0 15 6.7 15 15 0 1.3-.2 2.6-.5 3.8" fill="#87CEEB"/>
        <g stroke="#4A90D9" stroke-width="2.5" stroke-linecap="round">
          <line x1="22" y1="48" x2="19" y2="56"/>
          <line x1="32" y1="48" x2="29" y2="56"/>
          <line x1="42" y1="48" x2="39" y2="56"/>
          <line x1="27" y1="54" x2="24" y2="62"/>
          <line x1="37" y1="54" x2="34" y2="62"/>
        </g>
      </svg>`,
    'heavy-rain': `
      <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
        <path d="M48 32c0 4.4-3.6 8-8 8H20c-5.5 0-10-4.5-10-10s4.5-10 10-10c1 0 2 .1 3 .4C26.5 18 32.5 14 39 14c8.3 0 15 6.7 15 15 0 1.3-.2 2.6-.5 3.8" fill="#5B9BD5"/>
        <g stroke="#3A7BC8" stroke-width="3" stroke-linecap="round">
          <line x1="20" y1="46" x2="15" y2="58"/>
          <line x1="30" y1="46" x2="25" y2="58"/>
          <line x1="40" y1="46" x2="35" y2="58"/>
          <line x1="50" y1="46" x2="45" y2="58"/>
          <line x1="25" y1="52" x2="20" y2="64"/>
          <line x1="35" y1="52" x2="30" y2="64"/>
          <line x1="45" y1="52" x2="40" y2="64"/>
        </g>
      </svg>`,
    snow: `
      <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
        <path d="M48 34c0 4.4-3.6 8-8 8H20c-5.5 0-10-4.5-10-10s4.5-10 10-10c1 0 2 .1 3 .4C26.5 20 32.5 16 39 16c8.3 0 15 6.7 15 15 0 1.3-.2 2.6-.5 3.8" fill="#E0E0E0"/>
        <g fill="#FFFFFF" stroke="#B0B0B0" stroke-width="1">
          <circle cx="22" cy="52" r="3"/>
          <circle cx="32" cy="48" r="3"/>
          <circle cx="42" cy="52" r="3"/>
          <circle cx="27" cy="58" r="2.5"/>
          <circle cx="37" cy="58" r="2.5"/>
        </g>
      </svg>`,
    'heavy-snow': `
      <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
        <path d="M48 32c0 4.4-3.6 8-8 8H20c-5.5 0-10-4.5-10-10s4.5-10 10-10c1 0 2 .1 3 .4C26.5 18 32.5 14 39 14c8.3 0 15 6.7 15 15 0 1.3-.2 2.6-.5 3.8" fill="#D0D0D0"/>
        <g fill="#FFFFFF" stroke="#909090" stroke-width="1">
          <circle cx="18" cy="50" r="4"/>
          <circle cx="28" cy="46" r="4"/>
          <circle cx="38" cy="50" r="4"/>
          <circle cx="48" cy="46" r="4"/>
          <circle cx="23" cy="58" r="3.5"/>
          <circle cx="33" cy="58" r="3.5"/>
          <circle cx="43" cy="58" r="3.5"/>
        </g>
      </svg>`,
    thunder: `
      <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
        <path d="M48 30c0 4.4-3.6 8-8 8H20c-5.5 0-10-4.5-10-10s4.5-10 10-10c1 0 2 .1 3 .4C26.5 16 32.5 12 39 12c8.3 0 15 6.7 15 15 0 1.3-.2 2.6-.5 3.8" fill="#696969"/>
        <polygon points="32,40 26,54 34,54 28,62 40,46 32,46 38,38" fill="#FFD700" stroke="#FFA500" stroke-width="1"/>
      </svg>`,
    fog: `
      <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
        <g stroke="#C0C0C0" stroke-width="4" stroke-linecap="round">
          <line x1="12" y1="24" x2="52" y2="24"/>
          <line x1="16" y1="34" x2="48" y2="34"/>
          <line x1="12" y1="44" x2="52" y2="44"/>
        </g>
      </svg>`,
    mist: `
      <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
        <g stroke="#D3D3D3" stroke-width="3" stroke-linecap="round">
          <line x1="14" y1="28" x2="50" y2="28"/>
          <line x1="18" y1="38" x2="46" y2="38"/>
          <line x1="14" y1="48" x2="50" y2="48"/>
        </g>
      </svg>`,
    drizzle: `
      <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
        <path d="M48 34c0 4.4-3.6 8-8 8H20c-5.5 0-10-4.5-10-10s4.5-10 10-10c1 0 2 .1 3 .4C26.5 20 32.5 16 39 16c8.3 0 15 6.7 15 15 0 1.3-.2 2.6-.5 3.8" fill="#B0D4E8"/>
        <g stroke="#7BA7C9" stroke-width="2" stroke-linecap="round">
          <line x1="24" y1="50" x2="21" y2="56"/>
          <line x1="32" y1="50" x2="29" y2="56"/>
          <line x1="40" y1="50" x2="37" y2="56"/>
        </g>
      </svg>`,
    sleet: `
      <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
        <path d="M48 34c0 4.4-3.6 8-8 8H20c-5.5 0-10-4.5-10-10s4.5-10 10-10c1 0 2 .1 3 .4C26.5 20 32.5 16 39 16c8.3 0 15 6.7 15 15 0 1.3-.2 2.6-.5 3.8" fill="#C8D8E8"/>
        <g fill="#87CEEB" stroke="#4682B4" stroke-width="1">
          <circle cx="24" cy="52" r="3"/>
          <circle cx="40" cy="52" r="3"/>
        </g>
      </svg>`,
    cloud: `
      <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
        <path d="M52 40c0 4.4-3.6 8-8 8H16c-5.5 0-10-4.5-10-10s4.5-10 10-10c1 0 2 .1 3 .4C20.5 24 26.5 20 33 20c8.3 0 15 6.7 15 15 0 1.3-.2 2.6-.5 3.8" fill="#E8E8E8"/>
      </svg>`
  }

  return icons[icon] || icons.cloud
}
